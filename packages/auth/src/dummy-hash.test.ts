/**
 * The dummy hash is ready before the first login, not built during it.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM `password.test.ts`
 * `password.test.ts` asserts the two paths take *comparable time*, using a
 * wall clock. That assertion was flaky (dev log 0043), and the cause was a real
 * asymmetry rather than measurement noise: `getDummyHash` memoised with
 * `??=`, so the FIRST `verifyPasswordDummy` of a process performed a hash AND a
 * verify while `verifyPassword` performed a verify alone — measured at 1.68–2.35×
 * across eight fresh processes, against a test ceiling of 4×.
 *
 * ⚠️ THIS TEST IS DETERMINISTIC WHERE THAT ONE IS STATISTICAL. It counts calls
 * into argon2 instead of timing them, so it proves the structural property —
 * "the login path never pays for the dummy hash" — with no clock involved and
 * no way for a loaded machine to change the answer. The timing test stays as
 * the end-to-end check; this is what stops the underlying defect returning.
 *
 * @see docs/development-log/0044-two-flakes.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock is in place before `./password` is imported below —
// crucially including its MODULE-LOAD hash, which is the thing under test.
const { hashSpy, verifySpy } = vi.hoisted(() => ({
  hashSpy: vi.fn(async () => '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'),
  verifySpy: vi.fn(async () => false),
}));

vi.mock('@node-rs/argon2', () => ({
  hash: hashSpy,
  verify: verifySpy,
}));

// Imported AFTER the mock is registered. The module-load hash runs here.
const { verifyPassword, verifyPasswordDummy } = await import('./password');

describe('the dummy hash is precomputed at module load', () => {
  beforeEach(() => {
    verifySpy.mockClear();
    // `hashSpy` is deliberately NOT cleared in the first test — the count from
    // module load is exactly what it is asserting.
  });

  it('⚠️ hashes exactly ONCE at import, before any login is attempted', () => {
    // The docblock in password.ts promised this from the start; the code did
    // the opposite until dev log 0044. One call, made at module load.
    expect(hashSpy).toHaveBeenCalledTimes(1);
  });

  it('⚠️ the FIRST verifyPasswordDummy performs no hash — only a verify', async () => {
    // The regression this file exists for. Under the old lazy `??=`, this call
    // triggered a second `hash`, making the first "no such user" response cost
    // roughly twice a "wrong password" one.
    hashSpy.mockClear();

    await verifyPasswordDummy('wrong-password');

    expect(hashSpy, 'the login path paid for the dummy hash').not.toHaveBeenCalled();
    expect(verifySpy, 'the dummy did not perform a verification at all').toHaveBeenCalledTimes(1);
  });

  it('does the SAME argon2 work as a real verification', async () => {
    // The property the timing test measures, asserted structurally: one verify
    // and no hash, on both branches. If these ever diverge, the timing test's
    // flakiness is a symptom and this names the cause.
    hashSpy.mockClear();
    verifySpy.mockClear();
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', 'wrong-password');
    const real = { hash: hashSpy.mock.calls.length, verify: verifySpy.mock.calls.length };

    hashSpy.mockClear();
    verifySpy.mockClear();
    await verifyPasswordDummy('wrong-password');
    const dummy = { hash: hashSpy.mock.calls.length, verify: verifySpy.mock.calls.length };

    expect(dummy).toEqual(real);
  });

  it('stays at one hash however many logins are attempted', async () => {
    hashSpy.mockClear();

    for (let i = 0; i < 5; i += 1) {
      await verifyPasswordDummy(`attempt-${i}`);
    }

    expect(hashSpy, 'the dummy hash is being rebuilt per request').not.toHaveBeenCalled();
    expect(verifySpy).toHaveBeenCalledTimes(5);
  });
});
