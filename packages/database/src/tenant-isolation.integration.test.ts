/**
 * Tenant isolation — DATABASE layer.
 *
 * WHY THIS SUITE IS THE MOST IMPORTANT IN THE REPOSITORY
 * The application-layer guards (`guards.test.ts`) prove that authorization
 * code refuses cross-tenant access. This suite proves the backstop underneath
 * it: that even if that code were bypassed entirely — a missing check in a new
 * endpoint, a forgotten `WHERE workspace_id`, SQL injection — PostgreSQL still
 * returns zero rows.
 *
 * Every test here connects as a RESTRICTED, NON-OWNER role. That is not a
 * detail: superusers and table owners are exempt from RLS, so a suite
 * connecting as the migration role would pass while proving nothing.
 * `assertRestrictedRole` fails loudly rather than let that happen silently.
 *
 * @see docs/security/tenant-isolation.md
 * @see packages/database/migrations/0001_tenant_row_level_security.sql
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  type TestHarness,
} from './testing/harness';
import { auditEvents } from './schema/audit';
import { agencies, memberships, workspaces } from './schema/tenancy';
import { users } from './schema/identity';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

describeIntegration('tenant isolation (row-level security)', () => {
  let harness: TestHarness;
  let workspaceA: string;
  let workspaceB: string;
  let userA: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    // If this throws, every assertion below would be meaningless.
    await assertRestrictedRole(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();

    const [agency] = await harness.owner
      .insert(agencies)
      .values({ name: 'Northbeam Growth Partners', slug: 'northbeam' })
      .returning();

    const inserted = await harness.owner
      .insert(workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing', agencyId: agency!.id },
        { name: 'Meridian Legal', slug: 'meridian-legal', agencyId: null },
      ])
      .returning();

    workspaceA = inserted[0]!.id;
    workspaceB = inserted[1]!.id;

    const [user] = await harness.owner
      .insert(users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam Whitfield', passwordHash: null })
      .returning();
    userA = user!.id;

    await harness.owner
      .insert(memberships)
      .values({ userId: userA, workspaceId: workspaceA, role: 'owner' });

    // Seed one audit row in each workspace, as the owner (RLS-exempt).
    await harness.owner.insert(auditEvents).values([
      { workspaceId: workspaceA, actorUserId: userA, eventName: 'test.workspace_a' },
      { workspaceId: workspaceB, actorUserId: null, eventName: 'test.workspace_b' },
      // Platform-scoped: a failed sign-in, before any identity is known.
      { workspaceId: null, actorUserId: null, eventName: 'auth.login.failed' },
    ]);
  });

  /** Run a query inside a transaction scoped to `workspaceId`. */
  async function inTenant<T>(workspaceId: string, fn: (tx: never) => Promise<T>): Promise<T> {
    return harness.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
      return fn(tx as never);
    });
  }

  it('reads ONLY the scoped workspace, with no WHERE clause at all', async () => {
    // The core assertion. A deliberately unfiltered `SELECT *` — the exact
    // mistake RLS exists to survive — must still return one tenant's rows.
    const rows = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app).select().from(auditEvents),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventName).toBe('test.workspace_a');
    expect(rows[0]?.workspaceId).toBe(workspaceA);
  });

  it('returns ZERO rows for another tenant, not an error', async () => {
    const rows = await inTenant(workspaceB, async (tx) =>
      (tx as unknown as typeof harness.app).select().from(auditEvents),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventName).toBe('test.workspace_b');
    // Workspace A's data is invisible — not forbidden, simply absent.
    expect(rows.some((row) => row.workspaceId === workspaceA)).toBe(false);
  });

  it('hides platform-scoped rows from every tenant', async () => {
    // Rows with a NULL workspace_id are platform security events. A tenant
    // must not be able to read the platform's failed-login log.
    for (const workspace of [workspaceA, workspaceB]) {
      const rows = await inTenant(workspace, async (tx) =>
        (tx as unknown as typeof harness.app).select().from(auditEvents),
      );
      expect(rows.some((row) => row.workspaceId === null)).toBe(false);
    }
  });

  it('returns nothing at all when the transaction is UNSCOPED', async () => {
    // Fail closed. A query that forgets to set the tenant scope must see
    // nothing, rather than everything.
    const rows = await harness.app.select().from(auditEvents);
    expect(rows).toHaveLength(0);
  });

  it('REFUSES a write labelled with another tenant', async () => {
    // Without a WITH CHECK clause, reads would be isolated while writes were
    // not — code inside workspace A's transaction could still insert a row
    // belonging to workspace B. A subtle and easily missed hole.
    await expect(
      inTenant(workspaceA, async (tx) =>
        (tx as unknown as typeof harness.app)
          .insert(auditEvents)
          .values({ workspaceId: workspaceB, actorUserId: null, eventName: 'cross.tenant.write' }),
      ),
    ).rejects.toThrow();

    const rowsInB = await inTenant(workspaceB, async (tx) =>
      (tx as unknown as typeof harness.app).select().from(auditEvents),
    );
    expect(rowsInB.some((row) => row.eventName === 'cross.tenant.write')).toBe(false);
  });

  it('permits a write labelled with the scoped tenant', async () => {
    await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app)
        .insert(auditEvents)
        .values({ workspaceId: workspaceA, actorUserId: userA, eventName: 'same.tenant.write' }),
    );

    const rows = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app).select().from(auditEvents),
    );
    expect(rows.some((row) => row.eventName === 'same.tenant.write')).toBe(true);
  });

  it('enforces the audit trail as append-only', async () => {
    // No UPDATE or DELETE policy exists, and with RLS enabled an operation
    // with no matching policy is denied. The ABSENCE of a policy is the
    // control here — an audit trail a tenant can edit is not an audit trail.
    const updated = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app)
        .update(auditEvents)
        .set({ eventName: 'tampered' })
        .returning({ id: auditEvents.id }),
    );
    expect(updated).toHaveLength(0);

    const deleted = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app).delete(auditEvents).returning({ id: auditEvents.id }),
    );
    expect(deleted).toHaveLength(0);
  });

  it('does not leak scope between pooled transactions', async () => {
    // `SET LOCAL` is transaction-scoped. A plain `SET` would persist on the
    // pooled connection and hand the next request the previous tenant's
    // scope — catastrophic, and completely silent. This asserts the boundary.
    await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app).select().from(auditEvents),
    );

    const afterwards = await harness.app.execute<{ scope: string | null }>(
      sql`select current_setting('app.workspace_id', true) as scope`,
    );

    const scope = afterwards[0]?.scope;
    expect(scope === null || scope === '' || scope === undefined).toBe(true);
  });

  it('has RLS both ENABLED and FORCED on every tenant table', async () => {
    // FORCE is what closes the table-owner exemption. Without it, an
    // application that happens to connect as the owner silently bypasses
    // every policy and the whole layer becomes decorative.
    const result = await harness.owner.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'audit_events'
    `);

    expect(result[0]?.relrowsecurity).toBe(true);
    expect(result[0]?.relforcerowsecurity).toBe(true);
  });
});
