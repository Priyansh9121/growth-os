/**
 * Password reset — integration.
 *
 * WHAT THIS SUITE IS FOR
 * A reset token is a complete account takeover if it leaks, is reusable, or
 * outlives its window. Every property below is one of those failure modes
 * written as an assertion, against a real database, because all three are
 * transactional behaviours a mock cannot demonstrate.
 *
 * The enumeration tests matter as much as the token ones: an endpoint that
 * behaves differently for a known and an unknown address tells an attacker
 * which of ten thousand addresses are customers of this product, without ever
 * needing a password.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AuthenticationError, RateLimitError } from '@growth-os/contracts';
import {
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { hashPassword, verifyPassword } from './password';
import { MemoryRateLimiter } from './rate-limit';
import { createSession } from './session/store';
import {
  completePasswordReset,
  isResetTokenValid,
  requestPasswordReset,
  type PasswordResetDependencies,
  type PasswordResetNotifier,
} from './password-reset';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { passwordResetTokens, sessions, users } = schemaTables;

/** Captures the link instead of sending it, so the raw token is inspectable. */
class CapturingNotifier implements PasswordResetNotifier {
  readonly sent: { email: string; resetUrl: string; expiresAt: Date }[] = [];

  async send(reset: { email: string; resetUrl: string; expiresAt: Date }): Promise<void> {
    this.sent.push(reset);
  }

  get lastToken(): string | null {
    const last = this.sent.at(-1);
    if (!last) return null;
    return new URL(last.resetUrl).searchParams.get('token');
  }
}

describeIntegration('password reset', () => {
  let harness: TestHarness;
  let notifier: CapturingNotifier;
  let deps: PasswordResetDependencies;
  let userId: string;

  const SECRET = 'test-only-reset-secret-not-used-anywhere';

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    notifier = new CapturingNotifier();

    deps = {
      db: harness.owner as unknown as Database,
      rateLimiter: new MemoryRateLimiter(),
      notifier,
      secret: SECRET,
      appUrl: 'https://app.test',
      limits: { perIdentifierMax: 3, perIpMax: 10, windowSeconds: 900 },
    };

    const [user] = await harness.owner
      .insert(users)
      .values({
        email: 'sam@abcplumbing.test',
        name: 'Sam Whitfield',
        passwordHash: await hashPassword('the-original-password'),
      })
      .returning();
    userId = user!.id;
  });

  describe('requesting a link', () => {
    it('sends one for a known address', async () => {
      await requestPasswordReset(deps, 'sam@abcplumbing.test', { ipAddress: '203.0.113.1' });

      expect(notifier.sent).toHaveLength(1);
      expect(notifier.lastToken).toBeTruthy();
    });

    it('is indistinguishable for an unknown address', async () => {
      // Returns void either way. Without this, the endpoint enumerates every
      // customer of the product one address at a time.
      await expect(
        requestPasswordReset(deps, 'nobody@nowhere.test', { ipAddress: '203.0.113.1' }),
      ).resolves.toBeUndefined();

      expect(notifier.sent).toHaveLength(0);
      expect(await harness.owner.select().from(passwordResetTokens)).toHaveLength(0);
    });

    it('is indistinguishable for a disabled account', async () => {
      await harness.owner.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));

      await expect(
        requestPasswordReset(deps, 'sam@abcplumbing.test', { ipAddress: '203.0.113.1' }),
      ).resolves.toBeUndefined();

      expect(notifier.sent).toHaveLength(0);
    });

    it('normalises the address the same way sign-in does', async () => {
      // If these two ever disagreed, a user could be unable to reset the
      // password they signed up with.
      await requestPasswordReset(deps, '  SAM@ABCPlumbing.test  ', { ipAddress: '203.0.113.1' });

      expect(notifier.sent).toHaveLength(1);
    });

    it('stores only a hash, never the token', async () => {
      await requestPasswordReset(deps, 'sam@abcplumbing.test', { ipAddress: '203.0.113.1' });

      const [row] = await harness.owner.select().from(passwordResetTokens);
      const token = notifier.lastToken;

      expect(token).toBeTruthy();
      // A read-only database leak must not yield a usable reset link.
      expect(row?.tokenHash).not.toBe(token);
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('rate limits by address', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await requestPasswordReset(deps, 'sam@abcplumbing.test', { ipAddress: '203.0.113.1' });
      }

      // Tighter than sign-in on purpose: a failed login costs an attacker
      // nothing, but a reset request sends mail to a real person's inbox.
      await expect(
        requestPasswordReset(deps, 'sam@abcplumbing.test', { ipAddress: '203.0.113.1' }),
      ).rejects.toThrow(RateLimitError);
    });

    it('records the request without recording the address', async () => {
      await requestPasswordReset(deps, 'nobody@nowhere.test', { ipAddress: '203.0.113.1' });

      const events = await harness.owner.select().from(schemaTables.auditEvents);
      expect(events).toHaveLength(1);
      // An audit trail of probed addresses is itself a sensitive dataset.
      expect(JSON.stringify(events)).not.toContain('nobody@nowhere.test');
    });
  });

  describe('completing a reset', () => {
    async function requestToken(): Promise<string> {
      await requestPasswordReset(deps, 'sam@abcplumbing.test', { ipAddress: '203.0.113.1' });
      const token = notifier.lastToken;
      if (!token) throw new Error('No token was issued');
      return token;
    }

    it('sets the new password', async () => {
      const token = await requestToken();
      await completePasswordReset(deps, token, 'a-brand-new-password', {
        ipAddress: '203.0.113.1',
      });

      const [user] = await harness.owner.select().from(users).where(eq(users.id, userId));
      expect(await verifyPassword(user!.passwordHash!, 'a-brand-new-password')).toBe(true);
      expect(await verifyPassword(user!.passwordHash!, 'the-original-password')).toBe(false);
    });

    it('consumes the token, so it cannot be used twice', async () => {
      const token = await requestToken();
      await completePasswordReset(deps, token, 'a-brand-new-password', {
        ipAddress: '203.0.113.1',
      });

      await expect(
        completePasswordReset(deps, token, 'another-password-entirely', {
          ipAddress: '203.0.113.1',
        }),
      ).rejects.toThrow(AuthenticationError);
    });

    it('invalidates every other outstanding token for the user', async () => {
      const first = await requestToken();
      const second = await requestToken();

      await completePasswordReset(deps, second, 'a-brand-new-password', {
        ipAddress: '203.0.113.1',
      });

      // A second link forwarded to an attacker must die with the first.
      expect(await isResetTokenValid(deps.db, first, SECRET)).toBe(false);
    });

    it('revokes every session', async () => {
      await createSession(deps.db, userId, {
        secret: SECRET,
        idleTtlSeconds: 3600,
        absoluteTtlSeconds: 7200,
      });
      expect(await harness.owner.select().from(sessions)).not.toHaveLength(0);

      const token = await requestToken();
      await completePasswordReset(deps, token, 'a-brand-new-password', {
        ipAddress: '203.0.113.1',
      });

      // If the reset happened because the account was compromised, leaving the
      // attacker signed in makes the whole exercise pointless.
      //
      // Sessions are DELETED rather than flagged (see `revokeAllUserSessions`),
      // so the assertion is that none remain. A flag-based check would pass
      // vacuously against this implementation.
      const live = await harness.owner.select().from(sessions).where(eq(sessions.userId, userId));
      expect(live).toHaveLength(0);
    });

    it('refuses an expired token', async () => {
      const token = await requestToken();

      await harness.owner
        .update(passwordResetTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(passwordResetTokens.userId, userId));

      await expect(
        completePasswordReset(deps, token, 'a-brand-new-password', { ipAddress: '203.0.113.1' }),
      ).rejects.toThrow(AuthenticationError);

      const [user] = await harness.owner.select().from(users).where(eq(users.id, userId));
      expect(await verifyPassword(user!.passwordHash!, 'the-original-password')).toBe(true);
    });

    it('gives one message for invalid, expired and used tokens', async () => {
      const token = await requestToken();
      await completePasswordReset(deps, token, 'a-brand-new-password', {
        ipAddress: '203.0.113.1',
      });

      const messages: string[] = [];
      for (const candidate of [token, 'not-a-real-token-at-all']) {
        try {
          await completePasswordReset(deps, candidate, 'yet-another-password', {
            ipAddress: '203.0.113.1',
          });
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }

      // Distinguishing them would confirm that a given token was once real.
      expect(messages).toHaveLength(2);
      expect(new Set(messages).size).toBe(1);
    });

    it('reports validity without revealing whose token it is', async () => {
      const token = await requestToken();

      // A boolean, and nothing else. An endpoint that returned the account's
      // email address would turn a forwarded link into a disclosure.
      expect(await isResetTokenValid(deps.db, token, SECRET)).toBe(true);
      expect(await isResetTokenValid(deps.db, 'nonsense', SECRET)).toBe(false);
    });

    it('refuses a token hashed with a different secret', async () => {
      const token = await requestToken();

      // Rotating SESSION_SECRET must invalidate outstanding reset links, not
      // just active sessions.
      expect(await isResetTokenValid(deps.db, token, 'a-completely-different-secret')).toBe(false);
    });
  });
});
