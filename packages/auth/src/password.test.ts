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
    //
    // ⚠️ MEDIANS OF INTERLEAVED SAMPLES, NOT ONE MEASUREMENT EACH.
    //
    // This took a single sample of each and compared them. Both bounds below
    // are unchanged — what changed is how the two numbers are obtained, and
    // that is a STRENGTHENING rather than a loosening (§6):
    //
    //   - One sample of an ~8 ms operation is routinely disturbed by a GC
    //     pause or a scheduler preemption. Measured post-fix, single-sample
    //     ratios reached 4.33 while the true ratio was ~1.0 — a false failure.
    //   - The same noise can hide a real regression, since one lucky pair can
    //     land inside the bounds when the paths genuinely diverge. A median
    //     cannot be moved by one outlier in either direction.
    //   - Interleaving means machine load drifting mid-test moves both series
    //     together instead of biasing whichever ran second.
    //
    // Root cause of the original flake was NOT noise, and is fixed in
    // `password.ts`: the dummy hash was built lazily, so the first call did a
    // hash AND a verify against a bare verify — a structural ~2×. Proven
    // deterministically, with no clock, in `dummy-hash.test.ts`. This test is
    // the end-to-end check that the two paths really do cost the same.
    //
    // @see docs/development-log/0044-two-flakes.md
    const hash = await hashPassword('a-real-password');

    const time = async (run: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await run();
      return performance.now() - start;
    };
    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

    const realSamples: number[] = [];
    const dummySamples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      realSamples.push(await time(() => verifyPassword(hash, 'wrong-password')));
      dummySamples.push(await time(() => verifyPasswordDummy('wrong-password')));
    }

    const realMs = median(realSamples);
    const dummyMs = median(dummySamples);

    // A deliberately loose bound, UNCHANGED from when this was single-sample.
    // The point is that both perform a full Argon2 verification, not that
    // timings match to the millisecond — tightening this would produce a flaky
    // test on shared CI hardware without adding signal. Measured across 20
    // fresh processes, the median ratio sits between 0.86 and 1.26.
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
