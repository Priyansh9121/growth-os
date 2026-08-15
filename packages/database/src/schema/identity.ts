/**
 * Identity: users and sessions.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * These tables are deliberately NOT tenant-scoped. A user is a platform-global
 * identity that may hold memberships in many workspaces (an agency operator
 * works across 40 client workspaces with one account). Putting a
 * `workspace_id` on `users` would make the agency channel unbuildable, and
 * retrofitting memberships later would mean rewriting every authorization path
 * in the product.
 *
 * Because these tables are not tenant-scoped, they carry no row-level security
 * policy. Access to them is controlled entirely at the application layer.
 *
 * @see docs/architecture/multi-tenancy.md
 * @see docs/decisions/ADR-0005-multi-tenancy-model.md
 */

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Stored already normalised (trimmed, lowercased) by `emailSchema`. The
     * unique index below is therefore a genuine uniqueness guarantee rather
     * than a case-sensitive near-miss — without normalisation at write time,
     * `Sam@x.com` and `sam@x.com` would both be insertable.
     */
    email: text('email').notNull(),

    name: text('name').notNull(),

    /**
     * Argon2id PHC string. Contains the algorithm, parameters and salt, so
     * parameters can be raised later and existing hashes remain verifiable —
     * a rehash-on-login upgrade path requires no schema change.
     *
     * Nullable: a user invited but not yet activated, or a future SSO-only
     * user, has no password. Null here means "cannot authenticate with a
     * password", and the login path treats it exactly like a wrong password.
     */
    passwordHash: text('password_hash'),

    /**
     * Null until the address is verified. Verification is Stage 2; the column
     * exists now so that adding it later is not a migration on a populated
     * table.
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

    /**
     * Soft-disable. Checked at authentication, so disabling a user takes
     * effect on their next request rather than only at session expiry.
     */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      // Deleting a user must revoke their sessions atomically. Anything softer
      // leaves a valid cookie pointing at a deleted identity.
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * SHA-256(HMAC-SHA256(rawToken, SESSION_SECRET)).
     *
     * The raw token exists only in the user's cookie and is never persisted,
     * so a read-only database leak yields nothing usable without also
     * obtaining the application secret.
     *
     * Fast hashing is correct here, unlike for passwords: the input is 256
     * bits of random entropy, so it is not brute-forceable, and a slow hash
     * would add cost to every authenticated request for no security gain.
     */
    tokenHash: text('token_hash').notNull(),

    /**
     * Sliding idle expiry, extended on use. Bounds the value of a stolen
     * cookie for an account that is no longer active.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /**
     * Hard ceiling regardless of activity. Without this, an attacker with a
     * stolen cookie could refresh it indefinitely and never be forced out.
     */
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),

    /**
     * Weak client fingerprints, recorded for the user's "active sessions"
     * view and for incident investigation.
     *
     * NOT used as an authentication factor: both are trivially spoofable, and
     * mobile IPs change legitimately, so binding a session to them produces
     * false logouts without stopping an attacker who has the cookie.
     */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique: the lookup by token hash happens on every authenticated request
    // and must be an index hit, and duplicate hashes must be impossible.
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    // Supports "revoke all sessions for this user" and the active-sessions view.
    index('sessions_user_id_idx').on(table.userId),
    // Supports the expired-session sweep.
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

/**
 * Password reset tokens (Stage 2.5).
 *
 * SAME CONSTRUCTION AS SESSIONS AND INVITATIONS, deliberately: the raw token
 * is never persisted, only `SHA-256(HMAC(token, SESSION_SECRET))`. A read-only
 * database leak therefore yields no usable reset links, which matters more here
 * than anywhere else — a reset token is a complete account takeover.
 *
 * WHY A SEPARATE TABLE RATHER THAN COLUMNS ON `users`
 * Columns on `users` would make every read of a user carry a live credential,
 * and would make "how many reset attempts has this account had?" unanswerable.
 * A table also lets an expired or used token stay auditable for a while instead
 * of being overwritten by the next request.
 *
 * @see docs/decisions/ADR-0004-authentication.md
 * @see docs/security/authentication.md
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** `SHA-256(HMAC(token, SESSION_SECRET))`. The raw token exists only in the email. */
    tokenHash: text('token_hash').notNull(),

    /**
     * Short by design — 60 minutes. A reset link sits in an inbox, which is
     * exactly where an attacker who already has mailbox access is looking.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Set inside the consuming transaction. This is what makes it single-use. */
    usedAt: timestamp('used_at', { withTimezone: true }),

    /**
     * Recorded for the security audit trail, NOT for rate limiting — the
     * limiter runs before a token exists.
     */
    requestedIp: text('requested_ip'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('password_reset_tokens_hash_unique').on(table.tokenHash),
    // "Invalidate every outstanding token for this user" — issued on a
    // successful reset and on a password change.
    index('password_reset_tokens_user_idx').on(table.userId, table.createdAt),
  ],
);

export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
