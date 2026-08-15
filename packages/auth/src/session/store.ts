/**
 * Session lifecycle: create, validate, refresh, revoke.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Owns the `sessions` table. Every rule about when a session is valid lives
 * here, so "is this request authenticated?" has exactly one answer in the
 * codebase.
 *
 * @see docs/security/authentication.md
 * @see docs/decisions/ADR-0004-authentication.md
 */

import { and, eq, lt, ne } from 'drizzle-orm';
import type { Database } from '@growth-os/database';
import { schema } from '@growth-os/database';
import { generateSessionToken, hashSessionToken } from './tokens';

export interface SessionConfig {
  readonly secret: string;
  /** Sliding idle window, seconds. Extended on use. */
  readonly idleTtlSeconds: number;
  /** Hard ceiling from creation, seconds. Never extended. */
  readonly absoluteTtlSeconds: number;
}

export interface SessionClientInfo {
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface CreatedSession {
  readonly sessionId: string;
  /**
   * The raw token. This is the ONLY moment it exists in the system — it is
   * never persisted and cannot be recovered afterwards. Put it in a cookie
   * and let it go.
   */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ValidatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  /** True when this validation extended the idle window (a write occurred). */
  readonly refreshed: boolean;
}

/**
 * Fraction of the idle window that must elapse before a refresh writes to the
 * database.
 *
 * Refreshing on every request would mean an UPDATE per authenticated request —
 * significant write amplification for no security benefit. At 0.5, a session
 * is extended at most once per ~15 days of a 30-day window, while an active
 * user is never unexpectedly signed out.
 */
const REFRESH_THRESHOLD = 0.5;

/**
 * Create a session for a user.
 *
 * SESSION FIXATION
 * Callers must invoke this on every successful authentication and must never
 * reuse an existing session row. A brand-new token means a value an attacker
 * planted in the victim's browser before sign-in is not the value that ends up
 * authenticated.
 */
export async function createSession(
  db: Database,
  userId: string,
  config: SessionConfig,
  client: SessionClientInfo = {},
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token, config.secret);
  const now = Date.now();
  const expiresAt = new Date(now + config.idleTtlSeconds * 1000);
  const absoluteExpiresAt = new Date(now + config.absoluteTtlSeconds * 1000);

  const [row] = await db
    .insert(schema.sessions)
    .values({
      userId,
      tokenHash,
      expiresAt,
      absoluteExpiresAt,
      ipAddress: client.ipAddress ?? null,
      userAgent: client.userAgent ?? null,
    })
    .returning({ id: schema.sessions.id });

  if (!row) {
    throw new Error('Failed to create session row');
  }

  return { sessionId: row.id, token, expiresAt };
}

/**
 * Validate a raw session token.
 *
 * Returns `null` for every failure mode — not found, expired, past absolute
 * expiry, or belonging to a disabled user. The caller cannot distinguish
 * between them, and should not: a client has no legitimate use for the
 * difference, and exposing it would leak whether a token was ever valid.
 *
 * Checks the user's `disabled_at` in the same query, so disabling an account
 * takes effect on their next request rather than at session expiry — which is
 * what an administrator revoking access reasonably expects.
 */
export async function validateSession(
  db: Database,
  token: string,
  config: SessionConfig,
): Promise<ValidatedSession | null> {
  const tokenHash = hashSessionToken(token, config.secret);

  const [row] = await db
    .select({
      sessionId: schema.sessions.id,
      userId: schema.sessions.userId,
      expiresAt: schema.sessions.expiresAt,
      absoluteExpiresAt: schema.sessions.absoluteExpiresAt,
      createdAt: schema.sessions.createdAt,
      userDisabledAt: schema.users.disabledAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;

  const now = new Date();

  if (row.expiresAt <= now || row.absoluteExpiresAt <= now) {
    // Opportunistic cleanup. Deliberately not awaited-for-correctness: the
    // session is invalid regardless of whether the delete succeeds, and a
    // failure here must not turn a clean 401 into a 500.
    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, row.sessionId))
      .catch(() => {});
    return null;
  }

  if (row.userDisabledAt !== null) return null;

  // Sliding refresh, capped by the absolute expiry — a session can be extended
  // many times but can never outlive its hard ceiling.
  const idleWindowMs = config.idleTtlSeconds * 1000;
  const elapsedMs = idleWindowMs - (row.expiresAt.getTime() - now.getTime());
  let expiresAt = row.expiresAt;
  let refreshed = false;

  if (elapsedMs > idleWindowMs * REFRESH_THRESHOLD) {
    const proposed = new Date(now.getTime() + idleWindowMs);
    expiresAt = proposed > row.absoluteExpiresAt ? row.absoluteExpiresAt : proposed;
    await db
      .update(schema.sessions)
      .set({ expiresAt, lastUsedAt: now })
      .where(eq(schema.sessions.id, row.sessionId));
    refreshed = true;
  }

  return { sessionId: row.sessionId, userId: row.userId, expiresAt, refreshed };
}

/** Revoke one session. Used on sign-out. */
export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

/** Revoke by raw token, for a sign-out that only holds the cookie. */
export async function revokeSessionByToken(
  db: Database,
  token: string,
  config: SessionConfig,
): Promise<void> {
  await db
    .delete(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashSessionToken(token, config.secret)));
}

/**
 * Revoke every session for a user, optionally keeping one.
 *
 * Used after a password change (invalidate everything an attacker may hold
 * while keeping the user signed in where they are) and by an administrator
 * removing access.
 */
export async function revokeAllUserSessions(
  db: Database,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const condition =
    exceptSessionId === undefined
      ? eq(schema.sessions.userId, userId)
      : and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, exceptSessionId));

  const deleted = await db
    .delete(schema.sessions)
    .where(condition)
    .returning({ id: schema.sessions.id });
  return deleted.length;
}

/**
 * Delete expired sessions.
 *
 * Called by a scheduled job once `apps/worker` exists (Stage 3). Until then
 * `validateSession` prunes opportunistically, which keeps the table from
 * growing without bound but leaves rows for sessions that are never revisited.
 */
export async function pruneExpiredSessions(db: Database): Promise<number> {
  const deleted = await db
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, new Date()))
    .returning({ id: schema.sessions.id });
  return deleted.length;
}
