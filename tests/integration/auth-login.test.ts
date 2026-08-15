/**
 * The sign-in use case, end to end against a real database.
 *
 * WHAT THIS SUITE PROTECTS
 * The security properties of `packages/auth/src/login.ts` that only appear
 * when the pieces run together: enumeration parity, rate limiting ordering,
 * session fixation, and disabled-account handling. Unit tests cannot cover
 * these because the ordering IS the design.
 *
 * @see packages/auth/src/login.ts
 * @see docs/security/authentication.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestHarness, hasTestDatabase, type TestHarness } from '@growth-os/database/testing';
import { schema } from '@growth-os/database';
import {
  hashPassword,
  login,
  MemoryRateLimiter,
  resolveActor,
  validateSession,
  type SessionConfig,
} from '@growth-os/auth';
import { AuthenticationError, RateLimitError } from '@growth-os/contracts';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const SESSION_CONFIG: SessionConfig = {
  secret: 'integration-test-secret-at-least-32-characters-long',
  idleTtlSeconds: 60 * 60 * 24 * 30,
  absoluteTtlSeconds: 60 * 60 * 24 * 90,
};

const PASSWORD = 'a-valid-test-password-1';

describeIntegration('login', () => {
  let harness: TestHarness;
  let rateLimiter: MemoryRateLimiter;
  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;

  const context = {
    ipAddress: '203.0.113.10',
    userAgent: 'vitest',
    correlationId: 'test-correlation',
  };

  function deps() {
    return {
      // The owner connection: login legitimately runs unscoped, because it is
      // answering "who is this?" before any tenant is known.
      db: harness.owner as never,
      rateLimiter,
      sessionConfig: SESSION_CONFIG,
      limits: { perIdentifierMax: 5, perIpMax: 15, windowSeconds: 900 },
    };
  }

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    rateLimiter = new MemoryRateLimiter();

    const [user] = await harness.owner
      .insert(schema.users)
      .values({
        email: 'sam@abcplumbing.test',
        name: 'Sam Whitfield',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    userId = user!.id;

    const inserted = await harness.owner
      .insert(schema.workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing' },
        { name: 'Meridian Legal', slug: 'meridian-legal' },
      ])
      .returning();
    workspaceId = inserted[0]!.id;
    otherWorkspaceId = inserted[1]!.id;

    await harness.owner.insert(schema.memberships).values({ userId, workspaceId, role: 'owner' });
  });

  it('authenticates a valid user and issues a session', async () => {
    const result = await login(
      deps(),
      { email: 'sam@abcplumbing.test', password: PASSWORD },
      context,
    );

    expect(result.userId).toBe(userId);
    expect(result.token).toHaveLength(43); // 32 bytes, base64url, unpadded.

    const session = await validateSession(harness.owner as never, result.token, SESSION_CONFIG);
    expect(session?.userId).toBe(userId);
  });

  it('rejects a wrong password', async () => {
    await expect(
      login(deps(), { email: 'sam@abcplumbing.test', password: 'wrong-password' }, context),
    ).rejects.toThrow(AuthenticationError);
  });

  it('rejects an unknown email with the SAME public message as a wrong password', async () => {
    // Account enumeration: the two failures must be indistinguishable.
    let unknownMessage = '';
    let wrongMessage = '';

    try {
      await login(deps(), { email: 'nobody@nowhere.test', password: PASSWORD }, context);
    } catch (error) {
      unknownMessage = (error as AuthenticationError).publicMessage;
    }
    try {
      await login(deps(), { email: 'sam@abcplumbing.test', password: 'wrong' }, context);
    } catch (error) {
      wrongMessage = (error as AuthenticationError).publicMessage;
    }

    expect(unknownMessage).toBe(wrongMessage);
    expect(unknownMessage).toBe('Email or password is incorrect.');
  });

  it('treats a disabled account exactly like a wrong password', async () => {
    await harness.owner
      .update(schema.users)
      .set({ disabledAt: new Date() })
      .where(eq(schema.users.id, userId));

    await expect(
      login(deps(), { email: 'sam@abcplumbing.test', password: PASSWORD }, context),
    ).rejects.toThrow(AuthenticationError);
  });

  it('normalises email case and whitespace', async () => {
    // Registration and sign-in must agree, or the symptom is "my correct
    // password is rejected" — very hard to diagnose from a support ticket.
    const result = await login(
      deps(),
      { email: '  SAM@ABCPlumbing.TEST  ' as string, password: PASSWORD },
      context,
    );
    expect(result.userId).toBe(userId);
  });

  it('rate limits repeated failures for one identifier', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        login(deps(), { email: 'sam@abcplumbing.test', password: 'wrong' }, context),
      ).rejects.toThrow(AuthenticationError);
    }

    // The sixth attempt trips the limit — and does so even with the CORRECT
    // password, because limiting happens before verification.
    await expect(
      login(deps(), { email: 'sam@abcplumbing.test', password: PASSWORD }, context),
    ).rejects.toThrow(RateLimitError);
  });

  it('resets the identifier limit after a success', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        login(deps(), { email: 'sam@abcplumbing.test', password: 'wrong' }, context),
      ).rejects.toThrow(AuthenticationError);
    }

    await login(deps(), { email: 'sam@abcplumbing.test', password: PASSWORD }, context);

    // A legitimate user must not stay penalised for their own earlier typos.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        login(deps(), { email: 'sam@abcplumbing.test', password: 'wrong' }, context),
      ).rejects.toThrow(AuthenticationError);
    }
  });

  it('issues a NEW token on every sign-in (session fixation)', async () => {
    const first = await login(
      deps(),
      { email: 'sam@abcplumbing.test', password: PASSWORD },
      context,
    );
    const second = await login(
      deps(),
      { email: 'sam@abcplumbing.test', password: PASSWORD },
      context,
    );

    expect(first.token).not.toBe(second.token);
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it('never stores the raw token', async () => {
    // A read-only database leak must not yield anything usable.
    const result = await login(
      deps(),
      { email: 'sam@abcplumbing.test', password: PASSWORD },
      context,
    );

    const [row] = await harness.owner
      .select({ tokenHash: schema.sessions.tokenHash })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, result.sessionId));

    expect(row?.tokenHash).toBeDefined();
    expect(row?.tokenHash).not.toBe(result.token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes an audit event for success and for failure', async () => {
    await login(deps(), { email: 'sam@abcplumbing.test', password: PASSWORD }, context);
    await expect(
      login(deps(), { email: 'sam@abcplumbing.test', password: 'wrong' }, context),
    ).rejects.toThrow();

    const events = await harness.owner.select().from(schema.auditEvents);
    const names = events.map((event) => event.eventName);

    expect(names).toContain('auth.session.created');
    expect(names).toContain('auth.login.failed');
    // Platform-scoped: no tenant is known at authentication time.
    expect(events.every((event) => event.workspaceId === null)).toBe(true);
  });

  it('resolves the actor with ONLY their own workspaces', async () => {
    const result = await login(
      deps(),
      { email: 'sam@abcplumbing.test', password: PASSWORD },
      context,
    );
    const actor = await resolveActor(harness.owner as never, result.userId, result.sessionId);

    expect(actor?.workspaces).toHaveLength(1);
    expect(actor?.workspaces[0]?.workspaceId).toBe(workspaceId);
    expect(actor?.workspaces.some((w) => w.workspaceId === otherWorkspaceId)).toBe(false);
  });

  it('resolves agency-derived workspaces without any direct membership', async () => {
    // The agency model's central claim: transitive access, no membership rows
    // copied, `via: 'agency'` preserved for the audit trail.
    const [agency] = await harness.owner
      .insert(schema.agencies)
      .values({ name: 'Northbeam', slug: 'northbeam' })
      .returning();

    await harness.owner
      .update(schema.workspaces)
      .set({ agencyId: agency!.id })
      .where(eq(schema.workspaces.id, otherWorkspaceId));

    const [agencyUser] = await harness.owner
      .insert(schema.users)
      .values({
        email: 'riley@northbeam.test',
        name: 'Riley Okafor',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();

    await harness.owner
      .insert(schema.agencyMemberships)
      .values({ userId: agencyUser!.id, agencyId: agency!.id, role: 'agency_admin' });

    const result = await login(
      deps(),
      { email: 'riley@northbeam.test', password: PASSWORD },
      context,
    );
    const actor = await resolveActor(harness.owner as never, result.userId, result.sessionId);

    expect(actor?.workspaces).toHaveLength(1);
    expect(actor?.workspaces[0]?.workspaceId).toBe(otherWorkspaceId);
    expect(actor?.workspaces[0]?.via).toBe('agency');
    // agency_admin maps to workspace admin — not owner, so an agency employee
    // cannot remove the client's own owner.
    expect(actor?.workspaces[0]?.role).toBe('admin');
    // And they cannot see the workspace that is not theirs.
    expect(actor?.workspaces.some((w) => w.workspaceId === workspaceId)).toBe(false);
  });
});
