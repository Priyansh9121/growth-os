/**
 * Password hashing.
 *
 * These tests are slow by design — Argon2id is memory-hard and each operation
 * costs ~50ms. That cost IS the security property; a fast result here would
 * mean the parameters were wrong.
 *
 * @see docs/security/authentication.md
 */

import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  hashPassword,
  needsRehash,
  verifyPassword,
  verifyPasswordDummy,
} from './password';

describe('hashPassword', () => {
  it('produces an argon2id PHC string with the configured parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');

    // Guards the ambient-const-enum workaround in password.ts: if `ARGON2ID`
    // ever stopped meaning Argon2id, this fails instead of silently selecting
    // a weaker variant.
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('returns false — not throws — on a malformed hash', async () => {
    // A corrupted row must read as "authentication failed", not as a 500 that
    // reveals the row exists and is broken.
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });
});

describe('verifyPasswordDummy — account enumeration defence', () => {
  it('always returns false', async () => {
    expect(await verifyPasswordDummy('anything')).toBe(false);
  });

  it('takes comparable time to a real verification', async () => {
    // Without the dummy hash, an unknown email returns in ~1ms while a known
    // one takes ~50ms. That gap is trivially measurable and turns the login
    // endpoint into an oracle for which addresses have accounts.
    const hash = await hashPassword('a-real-password');

    const realStart = performance.now();
    await verifyPassword(hash, 'wrong-password');
    const realMs = performance.now() - realStart;

    const dummyStart = performance.now();
    await verifyPasswordDummy('wrong-password');
    const dummyMs = performance.now() - dummyStart;

    // A deliberately loose bound. The point is that both perform a full Argon2
    // verification, not that timings match to the millisecond — tightening this
    // would produce a flaky test on shared CI hardware without adding signal.
    expect(dummyMs).toBeGreaterThan(realMs * 0.25);
    expect(dummyMs).toBeLessThan(realMs * 4);
  });
});

describe('needsRehash', () => {
  it('is false for a hash at the current parameters', async () => {
    expect(needsRehash(await hashPassword('x'.repeat(16)))).toBe(false);
  });

  it('is true for weaker parameters', () => {
    // The upgrade path: parameters can be raised later and existing users are
    // migrated transparently on their next successful sign-in.
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('is true for an unrecognised or legacy algorithm', () => {
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true); // bcrypt
    expect(needsRehash('plaintext')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('constantTimeEquals', () => {
  it('compares equal and unequal values correctly', () => {
    expect(constantTimeEquals('token-value', 'token-value')).toBe(true);
    expect(constantTimeEquals('token-value', 'token-valuf')).toBe(false);
  });

  it('returns false on length mismatch instead of throwing', () => {
    // timingSafeEqual throws on differing lengths. Length is not secret, only
    // content is, so short-circuiting here is safe — and necessary, because an
    // uncaught throw in an auth path is a 500 an attacker can trigger at will.
    expect(constantTimeEquals('short', 'much-longer-value')).toBe(false);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });
});
