/**
 * Session token generation and hashing.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Defines the relationship between the opaque token in a user's cookie and
 * the row stored in `sessions`. Isolated in its own module because the
 * property it guarantees — that the database never holds anything usable as a
 * credential — must be checkable by reading one short file.
 *
 * @see docs/security/authentication.md
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * 32 bytes = 256 bits of entropy.
 *
 * Brute-forcing this is not a threat model at any conceivable scale, which is
 * why the token can be stored using a *fast* hash (see below) rather than a
 * slow password hash.
 */
const TOKEN_BYTES = 32;

/**
 * Generate a session token.
 *
 * base64url so the value is cookie-safe without percent-encoding — an encoded
 * token that gets double-decoded somewhere in the stack is a classic source of
 * intermittent, unreproducible logouts.
 */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Derive the value stored in `sessions.token_hash`.
 *
 * SHA-256(HMAC-SHA256(token, secret)).
 *
 * WHY HMAC AND THEN SHA-256
 * The HMAC binds the stored value to `SESSION_SECRET`, so an attacker with a
 * read-only copy of the database (a leaked backup, a SQL injection read, a
 * misconfigured replica) cannot use the contents to authenticate — they would
 * also need the application secret, which lives in a different system.
 *
 * The outer SHA-256 fixes the output to a compact, constant-width hex string
 * suitable for a unique btree index.
 *
 * WHY NOT ARGON2 HERE
 * Slow hashing exists to make guessing a *low-entropy* secret expensive. A
 * 256-bit random token cannot be guessed, so a slow hash would add ~50ms to
 * every authenticated request in exchange for nothing.
 *
 * ROTATION
 * Changing `SESSION_SECRET` changes every derived hash and therefore
 * invalidates every active session. That is intentional and is the documented
 * emergency "sign everyone out" procedure.
 */
export function hashSessionToken(token: string, secret: string): string {
  const keyed = createHmac('sha256', secret).update(token).digest();
  return createHash('sha256').update(keyed).digest('hex');
}
