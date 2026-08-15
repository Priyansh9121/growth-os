/**
 * The sign-in use case.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Composes every authentication control into one ordered, testable function.
 * The HTTP layer above it does nothing but parse a body, call this, and set a
 * cookie — so the security-relevant sequence lives in one place rather than
 * being spread across a route handler.
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY DESIGN
 * Each step below exists to close a specific attack, and several of them are
 * only correct in this order. Read the comments before reordering anything.
 *
 * @see docs/security/authentication.md
 * @see docs/decisions/ADR-0004-authentication.md
 */

import {
  AuthenticationError,
  emailSchema,
  RateLimitError,
  type LoginInput,
} from '@growth-os/contracts';
import { AUDIT_EVENTS, schema, type Database } from '@growth-os/database';
import { writeAuditEvent } from '@growth-os/database';
import { eq } from 'drizzle-orm';
import { needsRehash, hashPassword, verifyPassword, verifyPasswordDummy } from './password';
import { createSession, revokeAllUserSessions, type SessionConfig } from './session/store';
import { identifierKey, ipKey, type RateLimiter } from './rate-limit';

export interface LoginDependencies {
  readonly db: Database;
  readonly rateLimiter: RateLimiter;
  readonly sessionConfig: SessionConfig;
  readonly limits: {
    readonly perIdentifierMax: number;
    readonly perIpMax: number;
    readonly windowSeconds: number;
  };
}

export interface LoginRequestContext {
  readonly ipAddress: string;
  readonly userAgent?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface LoginSuccess {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly sessionId: string;
  /** Raw session token. Set it as a cookie and discard it. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Authenticate a user and create a session.
 *
 * @throws RateLimitError    Too many recent failures for this IP or identifier.
 * @throws AuthenticationError  Unknown email, wrong password, or disabled account —
 *   deliberately indistinguishable from one another to the caller.
 */
export async function login(
  deps: LoginDependencies,
  input: LoginInput,
  context: LoginRequestContext,
): Promise<LoginSuccess> {
  const { db, rateLimiter, limits } = deps;

  /**
   * Normalise defensively, using the same schema the HTTP layer uses.
   *
   * WHY RE-NORMALISE HERE
   * `login` is a public export of this package and will be called by hosts
   * that do not exist yet (the Fastify API, the voice service). Depending on
   * every caller to have parsed first is an unstated precondition, and its
   * failure mode is silent and awful: a user whose stored email is
   * `sam@x.test` types `Sam@X.test`, matches nothing, and is told their
   * password is wrong. The package boundary is a trust boundary, so it
   * validates its own input (ADR-0010).
   *
   * An unparseable email cannot match any stored user, so it falls through to
   * the normal failure path — including the dummy hash — rather than
   * short-circuiting, which would reintroduce a timing signal.
   */
  const parsedEmail = emailSchema.safeParse(input.email);
  const email = parsedEmail.success ? parsedEmail.data : input.email.trim().toLowerCase();

  // ---------------------------------------------------------------------------
  // 1. Rate limiting — BEFORE any database read or password hash.
  //
  // Argon2 verification is deliberately expensive (~19 MiB, ~50ms). Limiting
  // first means an attacker cannot use the login endpoint to burn our CPU and
  // memory, which would turn a credential-stuffing attempt into a denial of
  // service against everyone else.
  //
  // Two independent keys, both of which must pass: per-IP blunts spraying from
  // one source; per-identifier protects one account across many sources.
  // ---------------------------------------------------------------------------
  const ipLimitKey = ipKey('login', context.ipAddress);
  const identifierLimitKey = identifierKey('login:id', email);

  const [ipResult, identifierResult] = await Promise.all([
    rateLimiter.consume(ipLimitKey, limits.perIpMax, limits.windowSeconds),
    rateLimiter.consume(identifierLimitKey, limits.perIdentifierMax, limits.windowSeconds),
  ]);

  if (!ipResult.allowed || !identifierResult.allowed) {
    const retryAfterSeconds = Math.max(
      ipResult.retryAfterSeconds,
      identifierResult.retryAfterSeconds,
    );

    // Platform-scoped audit row (null workspace): at this point no
    // authenticated identity exists, so there is no tenant to attribute it to.
    await writeAuditEvent(db, {
      workspaceId: null,
      actorUserId: null,
      eventName: AUDIT_EVENTS.AUTH_RATE_LIMITED,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      correlationId: context.correlationId,
      // The email is NOT recorded. An audit table full of attempted addresses
      // is itself a sensitive dataset, and it is not needed to investigate a
      // rate-limit event.
      metadata: { scope: !ipResult.allowed ? 'ip' : 'identifier' },
    });

    throw new RateLimitError(
      `Login rate limit exceeded for ${!ipResult.allowed ? 'ip' : 'identifier'}`,
      retryAfterSeconds,
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Look up the user.
  // ---------------------------------------------------------------------------
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      passwordHash: schema.users.passwordHash,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  // ---------------------------------------------------------------------------
  // 3. Verify the password — with a dummy hash when there is no user.
  //
  // ACCOUNT ENUMERATION DEFENCE
  // Returning early here would make the "unknown email" path ~50ms faster than
  // the "wrong password" path, because only the latter runs Argon2. That
  // difference is measurable over a handful of requests and turns this
  // endpoint into an oracle for which email addresses have accounts.
  //
  // `verifyPasswordDummy` burns equivalent CPU and always returns false.
  // ---------------------------------------------------------------------------
  let passwordValid: boolean;

  if (!user || user.passwordHash === null) {
    passwordValid = await verifyPasswordDummy(input.password);
  } else {
    passwordValid = await verifyPassword(user.passwordHash, input.password);
  }

  // A disabled account is treated exactly like a wrong password — and only
  // AFTER the hash has been computed, so the timing is identical.
  if (!user || !passwordValid || user.disabledAt !== null) {
    await writeAuditEvent(db, {
      workspaceId: null,
      actorUserId: user?.id ?? null,
      eventName: AUDIT_EVENTS.AUTH_LOGIN_FAILED,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      correlationId: context.correlationId,
      metadata: {
        reason: !user
          ? 'unknown_user'
          : user.disabledAt !== null
            ? 'account_disabled'
            : 'bad_password',
      },
    });

    throw new AuthenticationError('Invalid credentials', {
      details: { email, reason: !user ? 'unknown_user' : 'bad_password' },
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Success — reset the identifier limit.
  //
  // Only the identifier counter is cleared, not the IP counter: a shared IP
  // (an office, a NAT gateway) must not have its protection reset by one
  // legitimate sign-in, or an attacker on that network could clear the limit
  // at will using their own valid credentials.
  // ---------------------------------------------------------------------------
  await rateLimiter.reset(identifierLimitKey);

  // ---------------------------------------------------------------------------
  // 5. Upgrade the password hash if our parameters have been raised.
  //
  // This is the only moment we legitimately hold the plaintext, so it is the
  // only moment a rehash is possible. Failure is non-fatal: the user is
  // authenticated, and a rehash failure must not deny them access.
  // ---------------------------------------------------------------------------
  // `passwordHash` is non-null here: a null hash forces `passwordValid` to
  // false above, which is caught by the guard. TypeScript cannot follow that
  // across the branch, so the narrowing is restated explicitly rather than
  // asserted away with `!`.
  if (user.passwordHash !== null && needsRehash(user.passwordHash)) {
    try {
      const upgraded = await hashPassword(input.password);
      await db
        .update(schema.users)
        .set({ passwordHash: upgraded })
        .where(eq(schema.users.id, user.id));
    } catch {
      // Intentionally swallowed. Logged by the caller's error boundary if it
      // recurs; never a reason to fail a valid sign-in.
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Create a NEW session.
  //
  // SESSION FIXATION DEFENCE
  // A fresh row and a fresh token every time. If an attacker planted a session
  // token in the victim's browser before sign-in, that token is not the one
  // that ends up authenticated.
  // ---------------------------------------------------------------------------
  const session = await createSession(db, user.id, deps.sessionConfig, {
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  await db
    .update(schema.users)
    .set({ lastLoginAt: new Date() })
    .where(eq(schema.users.id, user.id));

  await writeAuditEvent(db, {
    workspaceId: null,
    actorUserId: user.id,
    eventName: AUDIT_EVENTS.AUTH_LOGIN_SUCCEEDED,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    correlationId: context.correlationId,
    metadata: { sessionId: session.sessionId },
  });

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionId: session.sessionId,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

/**
 * Revoke every session for a user except the current one.
 *
 * Called after a password change: an attacker holding a stolen cookie is
 * signed out, while the legitimate user stays signed in where they are.
 */
export async function revokeOtherSessions(
  db: Database,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  return revokeAllUserSessions(db, userId, keepSessionId);
}
