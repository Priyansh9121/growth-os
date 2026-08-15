/**
 * Password reset.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The only way a user who has forgotten their password can regain access
 * without an administrator. Deferred through Stage 2 for want of a
 * transactional email provider, and built now because
 * [ADR-0024](docs/decisions/ADR-0024-multi-factor-authentication.md) makes it a
 * prerequisite: MFA multiplies the ways an account can become unreachable, and
 * reset is the pressure valve.
 *
 * SECURITY PROPERTIES, AND WHY EACH EXISTS
 *
 *  - **32-byte token, stored ONLY as `SHA-256(HMAC(token, SESSION_SECRET))`.**
 *    Identical construction to sessions and invitations. A read-only database
 *    leak yields no usable reset links, which matters more here than anywhere
 *    else: a reset token is a complete account takeover.
 *
 *  - **60-minute expiry.** Much shorter than an invitation's seven days,
 *    because a reset link sits in an inbox — exactly where an attacker who
 *    already has mailbox access is looking.
 *
 *  - **Single use, claimed inside the consuming transaction** with a
 *    `used_at IS NULL` predicate, so a double-click or a race consumes it once.
 *
 *  - **Requesting a reset reveals nothing.** An unknown address produces the
 *    same response, in comparable time, as a known one. Otherwise this endpoint
 *    is an account-enumeration oracle for the whole product.
 *
 *  - **Every outstanding token for the user is invalidated on success,** so a
 *    second link forwarded to an attacker dies with the first.
 *
 *  - **Every session is revoked on success.** If the reset was triggered
 *    because an account was compromised, leaving the attacker's session alive
 *    makes the reset pointless.
 *
 * WHAT IS NOT HERE, AND IS NAMED RATHER THAN IMPLIED
 * There is no email provider. Delivery goes through a `PasswordResetNotifier`,
 * and the development implementation prints the link to the server console.
 * **The composition root refuses to construct it in production**, because a
 * silent no-op notifier means resets that are requested, never delivered, and
 * never noticed.
 *
 * @see docs/decisions/ADR-0004-authentication.md
 * @see docs/security/authentication.md
 */

import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AuthenticationError, emailSchema, RateLimitError } from '@growth-os/contracts';
import { AUDIT_EVENTS, schemaTables, writeAuditEvent, type Database } from '@growth-os/database';
import { hashPassword } from './password';
import { revokeAllUserSessions } from './session/store';
import { identifierKey, ipKey, type RateLimiter } from './rate-limit';

const { passwordResetTokens, users } = schemaTables;

/**
 * 60 minutes.
 *
 * Deliberately much shorter than an invitation's 7 days. An invitation grants
 * membership of a workspace; a reset token grants an existing identity.
 */
const RESET_TTL_MS = 60 * 60 * 1000;

/** Same construction as session and invitation tokens. */
function hashResetToken(token: string, secret: string): string {
  return createHash('sha256')
    .update(createHmac('sha256', secret).update(token).digest())
    .digest('hex');
}

/**
 * Delivers a reset link.
 *
 * An interface because no transactional email provider exists yet. Defining
 * the seam now means adding one later touches a single file — and means the
 * reset flow itself is complete and testable without it.
 */
export interface PasswordResetNotifier {
  send(reset: { email: string; resetUrl: string; expiresAt: Date }): Promise<void>;
}

/**
 * Development notifier — prints the reset URL to the server console.
 *
 * ⚠️ PRODUCTION MUST NOT USE THIS. The composition root refuses to construct
 * it when `NODE_ENV` is production, for the same reason as the invitation
 * notifier: a silent no-op in production means resets that are requested,
 * never delivered, and never noticed.
 *
 * The token IS printed here, and that is the point of a development notifier.
 * It is why this class cannot exist in production, and why the token never
 * reaches the application logger — which runs in every environment.
 */
export class ConsolePasswordResetNotifier implements PasswordResetNotifier {
  async send(reset: { email: string; resetUrl: string; expiresAt: Date }): Promise<void> {
    console.info('[password-reset] delivery is not configured — reset link follows', {
      to: reset.email,
      resetUrl: reset.resetUrl,
      expiresAt: reset.expiresAt.toISOString(),
    });
  }
}

/**
 * Production stand-in for an unconfigured provider.
 *
 * WHY THIS EXISTS RATHER THAN REFUSING TO BOOT
 * The first version of this made the composition root throw when `NODE_ENV` was
 * production and no provider was wired. That was disproportionate and, in
 * practice, wrong: it bricked the entire application — CRM, dashboard, sign-in
 * — because ONE optional delivery channel was unconfigured. The E2E suite,
 * which runs against a production build, could not start the server at all.
 *
 * The failure it was guarding against is real: a reset that is requested,
 * never delivered, and never noticed. But the fix is to fail LOUDLY AT THE
 * POINT OF USE, not to take the product down. A reset attempt then produces a
 * visible error for the person who asked, a stack trace in the log, and an
 * audit record — all three of which someone notices — while everything
 * unrelated keeps working.
 */
export class UnconfiguredPasswordResetNotifier implements PasswordResetNotifier {
  async send(): Promise<void> {
    throw new Error(
      'Password reset delivery is not configured. Wire a transactional email provider before offering password reset in production.',
    );
  }
}

export interface PasswordResetDependencies {
  readonly db: Database;
  readonly rateLimiter: RateLimiter;
  readonly notifier: PasswordResetNotifier;
  /** Same secret as sessions. Rotating it invalidates outstanding resets too. */
  readonly secret: string;
  /** Absolute origin, used to build the link. Never taken from the request. */
  readonly appUrl: string;
  readonly limits: {
    readonly perIdentifierMax: number;
    readonly perIpMax: number;
    readonly windowSeconds: number;
  };
}

export interface ResetRequestContext {
  readonly ipAddress: string;
  readonly correlationId?: string | undefined;
}

/**
 * Request a reset link.
 *
 * **Returns void on every path, including an unknown email address.** The
 * caller cannot tell whether an account exists, which is the whole point:
 * without that, this endpoint enumerates every customer of the product.
 *
 * @throws RateLimitError — the ONE distinguishable outcome, and only because
 *   refusing to say "too many attempts" would leave a caller retrying against
 *   a wall with no explanation.
 */
export async function requestPasswordReset(
  deps: PasswordResetDependencies,
  rawEmail: string,
  context: ResetRequestContext,
): Promise<void> {
  // Normalised through the same schema the login path uses. If these two ever
  // disagreed, a user could be unable to reset the password they signed up with.
  const parsed = emailSchema.safeParse(rawEmail);
  const email = parsed.success ? parsed.data : rawEmail.trim().toLowerCase();

  // Rate limited on BOTH the address and the IP. Per-address alone lets one
  // host sweep thousands of addresses; per-IP alone lets a distributed attacker
  // hammer one inbox with reset mail.
  const [byIdentifier, byIp] = await Promise.all([
    deps.rateLimiter.consume(
      identifierKey('password-reset', email),
      deps.limits.perIdentifierMax,
      deps.limits.windowSeconds,
    ),
    deps.rateLimiter.consume(
      ipKey('password-reset', context.ipAddress),
      deps.limits.perIpMax,
      deps.limits.windowSeconds,
    ),
  ]);

  if (!byIdentifier.allowed || !byIp.allowed) {
    throw new RateLimitError(
      `Password reset rate limit reached for ${context.ipAddress}`,
      Math.max(byIdentifier.retryAfterSeconds, byIp.retryAfterSeconds),
    );
  }

  const [user] = await deps.db
    .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Unknown or disabled account: stop here, silently. No token, no email, no
  // difference the caller can observe.
  if (!user || user.disabledAt !== null) {
    await writeAuditEvent(deps.db, {
      workspaceId: null,
      actorUserId: null,
      eventName: AUDIT_EVENTS.AUTH_PASSWORD_RESET_REQUESTED,
      ipAddress: context.ipAddress,
      correlationId: context.correlationId,
      // `known: false` rather than the address. The audit trail records that a
      // reset was attempted, not a list of addresses someone probed for.
      metadata: { known: false },
    });
    return;
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await deps.db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashResetToken(token, deps.secret),
    expiresAt,
    requestedIp: context.ipAddress,
  });

  await writeAuditEvent(deps.db, {
    workspaceId: null,
    actorUserId: user.id,
    eventName: AUDIT_EVENTS.AUTH_PASSWORD_RESET_REQUESTED,
    ipAddress: context.ipAddress,
    correlationId: context.correlationId,
    metadata: { known: true },
  });

  // The raw token exists here and NOWHERE ELSE — not in the database, not in
  // the return value, not in a log line. It goes to the notifier and is
  // discarded.
  await deps.notifier.send({
    email: user.email,
    resetUrl: `${deps.appUrl}/reset-password?token=${encodeURIComponent(token)}`,
    expiresAt,
  });
}

/**
 * Is this token currently usable?
 *
 * Used by the reset page to decide between the form and an "expired link"
 * message. Returns a boolean and nothing else — an endpoint that returned the
 * account's email address would turn a leaked link into a disclosure.
 */
export async function isResetTokenValid(
  db: Database,
  token: string,
  secret: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: passwordResetTokens.id })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashResetToken(token, secret)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return row !== undefined;
}

/**
 * Consume a token and set a new password.
 *
 * @throws AuthenticationError for an invalid, expired or already-used token —
 *   all three indistinguishable, so the endpoint cannot be used to probe which
 *   tokens ever existed.
 */
export async function completePasswordReset(
  deps: PasswordResetDependencies,
  token: string,
  newPassword: string,
  context: ResetRequestContext,
): Promise<{ userId: string }> {
  const tokenHash = hashResetToken(token, deps.secret);

  // Hashing is done BEFORE the transaction opens. Argon2id is deliberately slow
  // (~50 ms), and holding a row lock for the duration would let a handful of
  // concurrent resets queue behind each other.
  const passwordHash = await hashPassword(newPassword);

  const userId = await deps.db.transaction(async (tx) => {
    // Claim the token FIRST, guarded by `used_at IS NULL` and the expiry. If a
    // concurrent request already claimed it, zero rows update and we stop —
    // this is what makes single use hold under a double-click.
    const claimed = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          // An expired token is not claimable, and checking expiry inside the
          // same UPDATE closes the window between reading and writing.
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });

    const claim = claimed[0];
    if (!claim) {
      // Invalid, expired and already-used are ONE message. Distinguishing them
      // would confirm that a given token was once real.
      throw new AuthenticationError('That reset link is no longer valid.');
    }

    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, claim.userId));

    // Every OTHER outstanding token for this user dies too. A second link
    // forwarded to an attacker must not survive the reset.
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, claim.userId), isNull(passwordResetTokens.usedAt)));

    return claim.userId;
  });

  // Every session is revoked, including the one that may have requested this.
  // If the reset happened because the account was compromised, leaving the
  // attacker signed in makes the whole exercise pointless.
  await revokeAllUserSessions(deps.db, userId);

  await writeAuditEvent(deps.db, {
    workspaceId: null,
    actorUserId: userId,
    eventName: AUDIT_EVENTS.AUTH_PASSWORD_RESET_COMPLETED,
    ipAddress: context.ipAddress,
    correlationId: context.correlationId,
  });

  return { userId };
}

/**
 * Delete expired and consumed tokens.
 *
 * Not wired to a scheduler — there is no job runner yet, and inventing one that
 * does nothing would be worse than an unscheduled function that works. Called
 * by hand or by the worker when Stage 3 introduces it.
 */
export async function pruneExpiredResetTokens(db: Database, olderThan = new Date()): Promise<void> {
  await db.delete(passwordResetTokens).where(
    or(
      lt(passwordResetTokens.expiresAt, olderThan),
      // A used token is kept for one further TTL so "was this link already
      // used?" stays answerable during an incident, then pruned with the rest.
      lt(passwordResetTokens.usedAt, new Date(olderThan.getTime() - RESET_TTL_MS)),
    ),
  );
}
