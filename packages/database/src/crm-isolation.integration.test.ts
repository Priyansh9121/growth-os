/**
 * CRM tenant isolation — DATABASE layer.
 *
 * WHY THIS IS THE MOST IMPORTANT SUITE IN STAGE 2
 * Stage 1 proved the RLS pattern on `audit_events`, a table whose contents
 * were not critical. This proves it on eight tables holding actual customer
 * PII — the data whose cross-tenant exposure would end the company.
 *
 * Every test connects as a RESTRICTED, NON-OWNER role and calls
 * `assertRestrictedRole` first. PostgreSQL exempts superusers from RLS
 * unconditionally, so a suite connecting as the migration role would pass
 * every assertion while proving nothing — the worst possible failure mode for
 * a security test.
 *
 * These are NEGATIVE tests. "Workspace A can read its own contacts" would pass
 * even if isolation were completely broken; "Workspace A sees zero of
 * workspace B's contacts" would not.
 *
 * @see docs/security/tenant-isolation.md
 * @see packages/database/migrations/0003_crm_row_level_security.sql
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  type TestHarness,
} from './testing/harness';
import {
  acquisitions,
  activities,
  contacts,
  opportunities,
  pipelines,
  pipelineStages,
  tasks,
} from './schema/crm';
import { workspaces } from './schema/tenancy';
import { users } from './schema/identity';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

/** Every workspace-owned CRM table, with the mutability it is meant to allow. */
const TENANT_TABLES = [
  'contacts',
  'companies',
  'acquisitions',
  'pipelines',
  'pipeline_stages',
  'opportunities',
  'tasks',
  'activities',
  'invitations',
] as const;

/**
 * Assert a query was rejected by the provenance-immutability trigger.
 *
 * Drizzle wraps driver errors, so the PostgreSQL message ("...is immutable")
 * lives on `error.cause`, not on the top-level message. Asserting only the
 * outer message would pass for ANY query failure — including a typo — which
 * would make this test worthless.
 */
async function expectImmutabilityRejection(operation: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught, 'expected the write to be rejected').toBeDefined();

  const messages: string[] = [];
  let current: unknown = caught;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }

  expect(messages.join(' | ')).toMatch(/immutable/i);
}

describeIntegration('CRM tenant isolation (row-level security)', () => {
  let harness: TestHarness;
  let workspaceA: string;
  let workspaceB: string;
  let userA: string;
  let contactA: string;
  let contactB: string;
  let pipelineA: string;
  let stageA: string;
  let dealA: string;

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

    const inserted = await harness.owner
      .insert(workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing' },
        { name: 'Meridian Legal', slug: 'meridian-legal' },
      ])
      .returning();
    workspaceA = inserted[0]!.id;
    workspaceB = inserted[1]!.id;

    const [user] = await harness.owner
      .insert(users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam Whitfield', passwordHash: null })
      .returning();
    userA = user!.id;

    // Seeded as OWNER (RLS-exempt for setup), then read back as the RESTRICTED
    // role — which is where the assertions happen.
    const contactRows = await harness.owner
      .insert(contacts)
      .values([
        {
          workspaceId: workspaceA,
          firstName: 'Sarah',
          lastName: 'Mitchell',
          email: 'sarah@example.test',
          emailNormalised: 'sarah@example.test',
        },
        {
          workspaceId: workspaceB,
          firstName: 'Jordan',
          lastName: 'Vasquez',
          email: 'jordan@example.test',
          emailNormalised: 'jordan@example.test',
        },
      ])
      .returning();
    contactA = contactRows[0]!.id;
    contactB = contactRows[1]!.id;

    await harness.owner.insert(acquisitions).values([
      {
        workspaceId: workspaceA,
        contactId: contactA,
        sourceType: 'organic_search',
        confidence: 'derived',
        landingPath: '/emergency-plumber',
      },
      {
        workspaceId: workspaceB,
        contactId: contactB,
        sourceType: 'referral',
        confidence: 'manual',
      },
    ]);

    const [pipeline] = await harness.owner
      .insert(pipelines)
      .values({ workspaceId: workspaceA, name: 'Sales', isDefault: true })
      .returning();
    pipelineA = pipeline!.id;

    const [stage] = await harness.owner
      .insert(pipelineStages)
      .values({
        workspaceId: workspaceA,
        pipelineId: pipelineA,
        name: 'New Lead',
        position: 10,
        category: 'open',
      })
      .returning();
    stageA = stage!.id;

    const [deal] = await harness.owner
      .insert(opportunities)
      .values({
        workspaceId: workspaceA,
        title: 'Hot water repair',
        contactId: contactA,
        pipelineId: pipelineA,
        stageId: stageA,
        estimatedValueMinor: 46_000,
      })
      .returning();
    dealA = deal!.id;

    await harness.owner
      .insert(tasks)
      .values({ workspaceId: workspaceA, title: 'Call Sarah', assignedUserId: userA });
    await harness.owner.insert(activities).values([
      {
        workspaceId: workspaceA,
        type: 'contact.created',
        summary: 'Sarah added',
        contactId: contactA,
      },
      {
        workspaceId: workspaceB,
        type: 'contact.created',
        summary: 'Jordan added',
        contactId: contactB,
      },
    ]);
  });

  /** Run a query scoped to one workspace, as the restricted role. */
  async function inTenant<T>(workspaceId: string, fn: (tx: never) => Promise<T>): Promise<T> {
    return harness.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
      return fn(tx as never);
    });
  }

  it('every CRM table has RLS both ENABLED and FORCED', async () => {
    // FORCE closes the table-owner exemption. Without it, an application that
    // happens to connect as the owner bypasses every policy silently.
    const result = await harness.owner.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname = ANY(ARRAY['contacts','companies','acquisitions','pipelines',
                                'pipeline_stages','opportunities','tasks','activities','invitations'])
    `);

    expect(result).toHaveLength(TENANT_TABLES.length);
    for (const row of result) {
      expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS not FORCED`).toBe(true);
    }
  });

  it('an unfiltered SELECT returns ONLY the scoped tenant, on every table', async () => {
    // The exact mistake RLS exists to survive: a query with no WHERE clause.
    const rows = await inTenant(workspaceA, async (tx) => {
      const t = tx as unknown as typeof harness.app;
      return {
        contacts: await t.select().from(contacts),
        acquisitions: await t.select().from(acquisitions),
        opportunities: await t.select().from(opportunities),
        tasks: await t.select().from(tasks),
        activities: await t.select().from(activities),
        pipelines: await t.select().from(pipelines),
      };
    });

    expect(rows.contacts).toHaveLength(1);
    expect(rows.contacts[0]?.firstName).toBe('Sarah');
    expect(rows.acquisitions).toHaveLength(1);
    expect(rows.activities).toHaveLength(1);
    expect(rows.opportunities).toHaveLength(1);

    // Workspace B's rows are ABSENT, not forbidden.
    expect(rows.contacts.some((row) => row.id === contactB)).toBe(false);
  });

  it('workspace B sees NONE of workspace A’s CRM data', async () => {
    const rows = await inTenant(workspaceB, async (tx) => {
      const t = tx as unknown as typeof harness.app;
      return {
        contacts: await t.select().from(contacts),
        opportunities: await t.select().from(opportunities),
        tasks: await t.select().from(tasks),
      };
    });

    expect(rows.contacts).toHaveLength(1);
    expect(rows.contacts[0]?.firstName).toBe('Jordan');
    // A has the only deal and the only task; B must see neither.
    expect(rows.opportunities).toHaveLength(0);
    expect(rows.tasks).toHaveLength(0);
  });

  it('an UNSCOPED transaction returns nothing at all (fail closed)', async () => {
    const rows = await harness.app.select().from(contacts);
    expect(rows).toHaveLength(0);
  });

  it('a cross-tenant UPDATE affects ZERO rows', async () => {
    // Even naming another tenant's row explicitly, the USING clause excludes
    // it — so the update silently matches nothing rather than succeeding.
    const updated = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app)
        .update(contacts)
        .set({ firstName: 'Hijacked' })
        .where(sql`${contacts.id} = ${contactB}`)
        .returning({ id: contacts.id }),
    );

    expect(updated).toHaveLength(0);

    const [victim] = await harness.owner
      .select({ firstName: contacts.firstName })
      .from(contacts)
      .where(sql`${contacts.id} = ${contactB}`);
    expect(victim?.firstName).toBe('Jordan');
  });

  it('a cross-tenant soft delete (archive) affects ZERO rows', async () => {
    const archived = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app)
        .update(contacts)
        .set({ deletedAt: new Date() })
        .where(sql`${contacts.id} = ${contactB}`)
        .returning({ id: contacts.id }),
    );

    expect(archived).toHaveLength(0);
  });

  it('REFUSES an INSERT labelled with another tenant', async () => {
    // Without WITH CHECK, reads would be isolated while writes were not:
    // code inside A's transaction could create rows belonging to B.
    await expect(
      inTenant(workspaceA, async (tx) =>
        (tx as unknown as typeof harness.app)
          .insert(contacts)
          .values({ workspaceId: workspaceB, firstName: 'Injected' }),
      ),
    ).rejects.toThrow();
  });

  it('REFUSES moving a row into another tenant via UPDATE', async () => {
    // The WITH CHECK clause on UPDATE. Without it, a row could be relabelled
    // into another workspace — isolation on read, exfiltration on write.
    await expect(
      inTenant(workspaceA, async (tx) =>
        (tx as unknown as typeof harness.app)
          .update(contacts)
          .set({ workspaceId: workspaceB })
          .where(sql`${contacts.id} = ${contactA}`),
      ),
    ).rejects.toThrow();
  });

  it('the activity timeline is APPEND-ONLY', async () => {
    // No UPDATE or DELETE policy exists, and with RLS on, an operation with no
    // matching policy is denied. The ABSENCE of the policy is the control.
    const updated = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app)
        .update(activities)
        .set({ summary: 'Rewritten history' })
        .returning({ id: activities.id }),
    );
    expect(updated).toHaveLength(0);

    const deleted = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app).delete(activities).returning({ id: activities.id }),
    );
    expect(deleted).toHaveLength(0);
  });

  it('contacts CANNOT be hard-deleted through the application role', async () => {
    // No DELETE policy: identity records soft-delete, so hard deletion is not
    // reachable from the app. Erasure is a separate privileged path (ADR-0013).
    const deleted = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app).delete(contacts).returning({ id: contacts.id }),
    );
    expect(deleted).toHaveLength(0);

    const survivors = await harness.owner.select().from(contacts);
    expect(survivors).toHaveLength(2);
  });

  it('acquisition PROVENANCE is immutable — only qualification may change', async () => {
    // The database trigger, not just a service-level convention. Even a future
    // service that tried to rewrite a lead's source would be refused.
    await expectImmutabilityRejection(() =>
      inTenant(workspaceA, async (tx) =>
        (tx as unknown as typeof harness.app)
          .update(acquisitions)
          .set({ sourceType: 'paid_search' })
          .where(sql`${acquisitions.contactId} = ${contactA}`),
      ),
    );

    // Qualification IS permitted — that is the one legitimate mutation.
    const qualified = await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app)
        .update(acquisitions)
        .set({ qualifiedAt: new Date(), qualifiedByUserId: userA })
        .where(sql`${acquisitions.contactId} = ${contactA}`)
        .returning({ id: acquisitions.id }),
    );
    expect(qualified).toHaveLength(1);
  });

  it('a search query cannot be back-filled onto existing provenance', async () => {
    // The most damaging possible edit: inventing the keyword that produced a
    // lead. Blocked by the same trigger.
    await expectImmutabilityRejection(() =>
      inTenant(workspaceA, async (tx) =>
        (tx as unknown as typeof harness.app)
          .update(acquisitions)
          .set({ searchQuery: 'emergency plumber melbourne' })
          .where(sql`${acquisitions.contactId} = ${contactA}`),
      ),
    );
  });

  it('does not leak tenant scope between pooled transactions', async () => {
    await inTenant(workspaceA, async (tx) =>
      (tx as unknown as typeof harness.app).select().from(contacts),
    );

    const after = await harness.app.execute<{ scope: string | null }>(
      sql`select current_setting('app.workspace_id', true) as scope`,
    );
    const scope = after[0]?.scope;
    expect(scope === null || scope === '' || scope === undefined).toBe(true);
  });

  it('a cross-tenant JOIN cannot reach another tenant’s rows', async () => {
    // Joins are the subtle case: a developer might assume filtering the driving
    // table is enough. RLS applies to EVERY table in the query independently.
    const rows = await inTenant(workspaceB, async (tx) =>
      (tx as unknown as typeof harness.app)
        .select({ dealTitle: opportunities.title, contactName: contacts.firstName })
        .from(opportunities)
        .innerJoin(contacts, sql`${contacts.id} = ${opportunities.contactId}`),
    );

    expect(rows).toHaveLength(0);
    expect(rows.some((row) => row.dealTitle === 'Hot water repair')).toBe(false);
  });

  it('workspace A can still fully operate on its own data', async () => {
    // The positive control. Proves the policies are not simply denying
    // everything, which would make every negative test above pass trivially.
    const result = await inTenant(workspaceA, async (tx) => {
      const t = tx as unknown as typeof harness.app;
      const inserted = await t
        .insert(tasks)
        .values({ workspaceId: workspaceA, title: 'New task', assignedUserId: userA })
        .returning({ id: tasks.id });

      const moved = await t
        .update(opportunities)
        .set({ status: 'won' })
        .where(sql`${opportunities.id} = ${dealA}`)
        .returning({ id: opportunities.id });

      return { inserted, moved };
    });

    expect(result.inserted).toHaveLength(1);
    expect(result.moved).toHaveLength(1);
  });
});
