/**
 * Password hashing and verification.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The only place in Growth OS that touches password material. Nothing else
 * imports the hashing library, so the algorithm and its parameters can be
 * changed in exactly one file.
 *
 * @see docs/decisions/ADR-0004-authentication.md
 * @see docs/security/authentication.md
 */

import { hash, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';
import { timingSafeEqual } from 'node:crypto';

/**
 * `Algorithm.Argon2id`.
 *
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, which
 * cannot be imported as a value under `verbatimModuleSyntax` (there is no
 * runtime object to import — the compiler would normally inline it, and
 * `isolatedModules` forbids relying on that). The numeric value is part of the
 * library's public, auto-generated API and is asserted by a unit test that
 * round-trips a hash, so a change upstream would fail CI rather than silently
 * select a weaker variant.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * Argon2id parameters, per OWASP's Password Storage Cheat Sheet (2024):
 * m = 19 MiB, t = 2, p = 1.
 *
 * WHY ARGON2id
 * The hybrid mode. Argon2i resists side-channel attacks but is weaker against
 * time-memory tradeoffs; Argon2d is the reverse. Argon2id combines both and is
 * the variant recommended for password storage.
 *
 * WHY THESE NUMBERS
 * Memory hardness is what defeats GPU and ASIC attacks — 19 MiB per hash means
 * an attacker cannot run tens of thousands of parallel guesses on commodity
 * hardware the way they can with a fast hash. The cost is real for us too:
 * roughly 40–80ms per verification on typical server hardware, which is
 * acceptable on a login path and intolerable anywhere else. Do not call this
 * in a loop.
 *
 * These parameters are embedded in each PHC-format hash, so they can be raised
 * later and existing hashes remain verifiable — see `needsRehash`.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A precomputed hash used when no user exists for a submitted email.
 *
 * WHY THIS EXISTS
 * Without it, a request for a nonexistent account returns in ~1ms while a
 * request for a real account takes ~50ms, because only the latter performs a
 * hash. That difference is trivially measurable over a handful of requests and
 * turns the login endpoint into an account-enumeration oracle — which converts
 * a password-guessing problem into a targeted phishing list.
 *
 * Generated at module load so the value is never a constant an attacker could
 * recognise, and so no plaintext password is embedded in the source.
 *
 * ⚠️ IT IS STARTED AT MODULE LOAD, NOT ON FIRST USE — and it used to say so
 * while doing the opposite. `dummyHashPromise ??= hash(...)` inside the getter
 * meant the FIRST `verifyPasswordDummy` of a process paid for a hash AND a
 * verify, while `verifyPassword` paid for a verify alone. Measured across eight
 * fresh processes: the first call ran at 1.68–2.35× a real verification
 * (mean 2.07), and every subsequent call at 0.79–1.11×.
 *
 * That is a timing difference between "no such user" and "wrong password" on
 * the first login after a boot, which is the exact signal this constant exists
 * to erase. It is in the SAFE direction — unknown-email is slower, not faster,
 * so it does not hand an attacker the enumeration oracle — and it affects one
 * request per process, so the practical risk was low. It was still the opposite
 * of what the paragraph above promised, and it was what made
 * `password.test.ts`'s timing assertion flaky: the test compared a hash+verify
 * against a verify and allowed 4×, leaving only 2× of headroom for noise.
 *
 * Starting it here costs nothing on the request path. `hash` runs on argon2's
 * own threadpool, so import returns immediately and the work completes long
 * before a first login arrives.
 *
 * @see docs/development-log/0044-two-flakes.md
 */
function startDummyHash(): Promise<string> {
  return hash(
    // 32 random bytes; the plaintext is discarded and never needed again.
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    ARGON2_OPTIONS,
  );
}

const dummyHashPromise: Promise<string> = startDummyHash();

// A rejection here must not become an unhandled rejection that takes down the
// process at import time. The failure is re-raised at the call site instead,
// where `verifyPassword` already treats an unusable hash as "authentication
// failed" rather than as a 500.
dummyHashPromise.catch(() => undefined);

function getDummyHash(): Promise<string> {
  return dummyHashPromise;
}

/** Hash a password for storage. Returns a PHC string including algorithm, parameters and salt. */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed hash: a corrupted row
 * must read as "authentication failed", not as a 500 that reveals the row
 * exists and is broken.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Burn equivalent CPU time when no user (or no password hash) was found.
 *
 * ALWAYS call this on the "user not found" branch of a login. The return value
 * is always `false`; it exists solely so the timing of a failed lookup matches
 * the timing of a failed verification.
 */
export async function verifyPasswordDummy(plaintext: string): Promise<false> {
  await verifyPassword(await getDummyHash(), plaintext);
  return false;
}

/**
 * Should this hash be upgraded?
 *
 * Called after a SUCCESSFUL verification — the only moment we legitimately
 * hold the plaintext and can re-hash it. Lets us raise parameters over time
 * without forcing a password reset on anyone.
 *
 * Parses the PHC string rather than using a library helper so the check does
 * not depend on binding-specific behaviour.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true; // Unrecognised format — including any legacy algorithm.

  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}

/**
 * Constant-time comparison of two secrets.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length,
 * so lengths are compared first and a mismatch short-circuits. That is safe:
 * the length of a token is not secret, only its content is.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
