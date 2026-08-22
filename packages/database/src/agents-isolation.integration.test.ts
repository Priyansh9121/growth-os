/**
 * The agent platform at the DATABASE layer — isolation, and the constraints
 * that make an agent's output attributable.
 *
 * WHY THESE ARE DATABASE TESTS AND NOT SERVICE TESTS
 * Nothing writes these tables yet. Every rule below is therefore enforced in
 * exactly one place — PostgreSQL — and a test that asserted "the service
 * validates it" would be asserting about code that does not exist. AGENTS.md
 * §6: not "validation ran" but "the row was refused by the database".
 *
 * The headline is `agent_outputs.agent_run_id`. An output that cannot name the
 * run that produced it is an unattributed claim about what an AI decided, and
 * the whole Phase 0 data model exists to make that row impossible to write.
 * `refuses an agent_output with a NULL agent_run_id` is the test that proves
 * it, and it inserts through raw SQL specifically so the TypeScript types
 * cannot be what stops it.
 *
 * Every isolation test connects as a RESTRICTED, NON-OWNER role and calls
 * `assertRestrictedRole` first — superusers are exempt from RLS
 * unconditionally, so a suite connecting as the migration role would pass
 * every assertion while proving nothing.
 *
 * @see packages/database/migrations/0014_agent_platform.sql
 * @see docs/decisions/ADR-0063-agent-platform-data-model.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  type TestHarness,
} from './testing/harness';
import { agentOutputs, agentRuns, approvals, attributionEvents, campaigns } from './schema/agents';
import { contacts } from './schema/crm';
import { workspaces } from './schema/tenancy';
import { users } from './schema/identity';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const AGENT_TABLES = [
  'campaigns',
  'agent_runs',
  'agent_outputs',
  'approvals',
  'attribution_events',
] as const;

/**
 * Assert a statement was refused, and that the refusal says what we expect.
 *
 * Drizzle wraps driver errors, so the PostgreSQL message lives on
 * `error.cause` rather than the top-level message. Matching only the outer
 * message would pass for ANY failure — a typo in a column name included —
 * which would make every test in this file worthless.
 */
async function expectRefusal(operation: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught, 'the database ACCEPTED a row it should have refused').toBeDefined();

  const messages: string[] = [];
  let current: unknown = caught;
  while (current) {
    if (current instanceof Error) messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }

  expect(messages.join(' | ')).toMatch(pattern);
}

describeIntegration('agent platform — tenant isolation and provenance constraints', () => {
  let harness: TestHarness;
  let workspaceA: string;
  let workspaceB: string;
  let userA: string;
  let campaignA: string;
  let runA: string;
  let runB: string;
  let outputA: string;
  let publishedOutputA: string;
  let contactA: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    // If this throws, every isolation assertion below would be meaningless.
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

    const [contact] = await harness.owner
      .insert(contacts)
      .values({
        workspaceId: workspaceA,
        firstName: 'Sarah',
        lastName: 'Mitchell',
        email: 'sarah@example.test',
        emailNormalised: 'sarah@example.test',
      })
      .returning();
    contactA = contact!.id;

    const [campaign] = await harness.owner
      .insert(campaigns)
      .values({
        workspaceId: workspaceA,
        name: 'Spring boiler servicing',
        startsAt: new Date('2026-03-01T00:00:00Z'),
        endsAt: new Date('2026-05-31T00:00:00Z'),
        createdByUserId: userA,
      })
      .returning();
    campaignA = campaign!.id;

    // Seeded as OWNER (RLS-exempt for setup); assertions read back as the
    // RESTRICTED role.
    const runRows = await harness.owner
      .insert(agentRuns)
      .values([
        { workspaceId: workspaceA, campaignId: campaignA, agentKey: 'seo-brief', inputs: {} },
        { workspaceId: workspaceB, agentKey: 'seo-brief', inputs: {} },
      ])
      .returning();
    runA = runRows[0]!.id;
    runB = runRows[1]!.id;

    const outputRows = await harness.owner
      .insert(agentOutputs)
      .values([
        {
          workspaceId: workspaceA,
          agentRunId: runA,
          kind: 'blog_outline',
          content: { title: 'Boiler servicing in winter' },
        },
        {
          workspaceId: workspaceA,
          agentRunId: runA,
          kind: 'blog_outline',
          content: { title: 'Already published' },
          publishedAt: new Date('2026-03-10T00:00:00Z'),
        },
        {
          workspaceId: workspaceB,
          agentRunId: runB,
          kind: 'blog_outline',
          content: { title: "Meridian's draft" },
        },
      ])
      .returning();
    outputA = outputRows[0]!.id;
    publishedOutputA = outputRows[1]!.id;
  });

  /** Run a query scoped to one workspace, as the restricted role. */
  async function inTenant<T>(workspaceId: string, fn: (tx: never) => Promise<T>): Promise<T> {
    return harness.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
      return fn(tx as never);
    });
  }

  // -------------------------------------------------------------------------
  // The rule this entire data model exists to protect
  // -------------------------------------------------------------------------

  describe('⚠️ provenance: an output must name the run that produced it', () => {
    it('the DATABASE refuses an agent_output with a NULL agent_run_id', async () => {
      // Raw SQL on purpose. Drizzle's types already make this unwriteable in
      // TypeScript, and a test that only proved the type system works would
      // prove nothing about the row a future migration, psql session or
      // service in another language could write.
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO agent_outputs (workspace_id, agent_run_id, kind, content)
            VALUES (${workspaceA}, NULL, 'blog_outline', '{}'::jsonb)
          `),
        /null value in column "agent_run_id"|violates not-null constraint/i,
      );
    });

    it('the refusal holds for the OWNER too, not just the restricted role', async () => {
      // A NOT NULL constraint is not an RLS policy: it binds the migration role
      // as well. Stated as its own test because "the app cannot do it" and
      // "nothing can do it" are different guarantees, and only the second one
      // makes provenance structural.
      const asOwner = await harness.owner.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM information_schema.columns
        WHERE table_name = 'agent_outputs'
          AND column_name = 'agent_run_id'
          AND is_nullable = 'NO'
      `);
      expect(asOwner[0]?.count).toBe('1');
    });

    it('deleting a run takes its outputs with it, leaving no orphan', async () => {
      await harness.owner.execute(sql`DELETE FROM agent_runs WHERE id = ${runA}`);
      const remaining = await harness.owner.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM agent_outputs WHERE agent_run_id = ${runA}`,
      );
      expect(remaining[0]?.count).toBe('0');
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('every agent table has RLS both ENABLED and FORCED', async () => {
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
          AND relname = ANY(ARRAY['campaigns','agent_runs','agent_outputs',
                                  'approvals','attribution_events'])
      `);

      expect(result).toHaveLength(AGENT_TABLES.length);
      for (const row of result) {
        expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} RLS not FORCED`).toBe(true);
      }
    });

    it('an unfiltered SELECT returns ONLY the scoped tenant', async () => {
      // The exact mistake RLS exists to survive: a query with no WHERE clause.
      const rows = await inTenant(workspaceA, async (tx) => {
        const t = tx as unknown as typeof harness.app;
        return {
          campaigns: await t.select().from(campaigns),
          runs: await t.select().from(agentRuns),
          outputs: await t.select().from(agentOutputs),
        };
      });

      expect(rows.campaigns).toHaveLength(1);
      expect(rows.runs).toHaveLength(1);
      expect(rows.runs[0]?.id).toBe(runA);
      // Two of workspace A's three seeded outputs; the Meridian one is invisible.
      expect(rows.outputs).toHaveLength(2);
      expect(rows.outputs.map((o) => o.id).sort()).toEqual([outputA, publishedOutputA].sort());
    });

    it('workspace B sees none of workspace A’s runs or outputs', async () => {
      const rows = await inTenant(workspaceB, async (tx) => {
        const t = tx as unknown as typeof harness.app;
        return {
          runs: await t.select().from(agentRuns),
          outputs: await t.select().from(agentOutputs),
          campaigns: await t.select().from(campaigns),
        };
      });

      expect(rows.runs).toHaveLength(1);
      expect(rows.runs[0]?.id).toBe(runB);
      expect(rows.outputs).toHaveLength(1);
      expect(rows.outputs[0]?.workspaceId).toBe(workspaceB);
      // Workspace A owns the only campaign.
      expect(rows.campaigns).toHaveLength(0);
    });

    it('an unscoped transaction sees nothing at all — fail closed', async () => {
      // `app_current_workspace_id()` returns NULL when unset, so every policy
      // matches zero rows rather than every row.
      const rows = await harness.app.transaction(async (tx) => ({
        runs: await tx.select().from(agentRuns),
        outputs: await tx.select().from(agentOutputs),
      }));

      expect(rows.runs).toHaveLength(0);
      expect(rows.outputs).toHaveLength(0);
    });

    it('a tenant cannot INSERT a run into another workspace', async () => {
      await expectRefusal(
        () =>
          inTenant(workspaceA, async (tx) => {
            const t = tx as unknown as typeof harness.app;
            return t.insert(agentRuns).values({ workspaceId: workspaceB, agentKey: 'seo-brief' });
          }),
        /row-level security|violates row-level security policy/i,
      );
    });

    it('a tenant cannot move a run into another workspace by UPDATE', async () => {
      // WITH CHECK, not just USING. Without it the UPDATE policy would allow a
      // row to be rewritten out of the tenant that owns it.
      await expectRefusal(
        () =>
          inTenant(workspaceA, async (tx) => {
            const t = tx as unknown as typeof harness.app;
            return t.execute(
              sql`UPDATE agent_runs SET workspace_id = ${workspaceB} WHERE id = ${runA}`,
            );
          }),
        /row-level security|violates row-level security policy/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Append-only tables
  // -------------------------------------------------------------------------

  describe('approvals and attribution are append-only', () => {
    it('a decision cannot be rewritten — no UPDATE policy exists', async () => {
      const [approval] = await harness.owner
        .insert(approvals)
        .values({
          workspaceId: workspaceA,
          agentOutputId: outputA,
          decision: 'approved',
          decidedByUserId: userA,
        })
        .returning();

      // With RLS enabled, an operation with NO matching policy is DENIED. The
      // absence of the policy IS the enforcement (ADR-0013).
      const updated = await inTenant(workspaceA, async (tx) => {
        const t = tx as unknown as typeof harness.app;
        return t.execute(
          sql`UPDATE approvals SET decision = 'rejected' WHERE id = ${approval!.id}`,
        );
      });
      expect(updated.count ?? 0).toBe(0);

      // And the stored decision is unchanged.
      const after = await harness.owner.execute<{ decision: string }>(
        sql`SELECT decision FROM approvals WHERE id = ${approval!.id}`,
      );
      expect(after[0]?.decision).toBe('approved');
    });

    it('a tenant cannot DELETE an approval', async () => {
      const [approval] = await harness.owner
        .insert(approvals)
        .values({ workspaceId: workspaceA, agentOutputId: outputA, decision: 'rejected' })
        .returning();

      const deleted = await inTenant(workspaceA, async (tx) => {
        const t = tx as unknown as typeof harness.app;
        return t.execute(sql`DELETE FROM approvals WHERE id = ${approval!.id}`);
      });
      expect(deleted.count ?? 0).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Limits live in the database (AGENTS.md §5)
  // -------------------------------------------------------------------------

  describe('CHECK constraints refuse rows the application must never write', () => {
    it('autonomy_level outside the four known levels is refused', async () => {
      for (const level of [0, 5, -1]) {
        await expectRefusal(
          () =>
            harness.owner.execute(sql`
              INSERT INTO agent_outputs (workspace_id, agent_run_id, kind, content, autonomy_level)
              VALUES (${workspaceA}, ${runA}, 'blog_outline', '{}'::jsonb, ${level})
            `),
          /agent_outputs_autonomy_level_is_known/i,
        );
      }
    });

    it('the four known levels are all accepted', async () => {
      // The negative test above is only meaningful if the bound is not simply
      // rejecting everything.
      for (const level of [1, 2, 3, 4]) {
        await harness.owner.execute(sql`
          INSERT INTO agent_outputs (workspace_id, agent_run_id, kind, content, autonomy_level)
          VALUES (${workspaceA}, ${runA}, 'blog_outline', '{}'::jsonb, ${level})
        `);
      }
      const stored = await harness.owner.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM agent_outputs WHERE agent_run_id = ${runA}`,
      );
      // Two seeded plus four written here.
      expect(stored[0]?.count).toBe('6');
    });

    it('an output defaults to autonomy level 2, which is what Phase 0 writes', async () => {
      const [row] = await harness.owner
        .insert(agentOutputs)
        .values({
          workspaceId: workspaceA,
          agentRunId: runA,
          kind: 'blog_outline',
          content: {},
        })
        .returning();
      expect(row!.autonomyLevel).toBe(2);
    });

    it('an edited approval without a diff is refused, and so is a diff without an edit', async () => {
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO approvals (workspace_id, agent_output_id, decision)
            VALUES (${workspaceA}, ${outputA}, 'edited')
          `),
        /approvals_edit_diff_iff_edited/i,
      );

      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO approvals (workspace_id, agent_output_id, decision, edit_diff)
            VALUES (${workspaceA}, ${outputA}, 'approved', '{"title":"changed"}'::jsonb)
          `),
        /approvals_edit_diff_iff_edited/i,
      );
    });

    it('a completed run must carry a completion time, and a running one must not', async () => {
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO agent_runs (workspace_id, agent_key, status, completed_at)
            VALUES (${workspaceA}, 'seo-brief', 'completed', NULL)
          `),
        /agent_runs_completion_matches_status/i,
      );

      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO agent_runs (workspace_id, agent_key, status, completed_at)
            VALUES (${workspaceA}, 'seo-brief', 'running', now())
          `),
        /agent_runs_completion_matches_status/i,
      );
    });

    it('a failure reason on a run that did not fail is refused', async () => {
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO agent_runs (workspace_id, agent_key, status, completed_at, failure_reason)
            VALUES (${workspaceA}, 'seo-brief', 'completed', now(), 'timed out')
          `),
        /agent_runs_failure_reason_requires_failure/i,
      );
    });

    it('a campaign that ends before it starts is refused', async () => {
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO campaigns (workspace_id, name, starts_at, ends_at)
            VALUES (${workspaceA}, 'Backwards', now(), now() - interval '1 day')
          `),
        /campaigns_ends_after_it_starts/i,
      );
    });

    it('an empty agent_key is refused, and so is an absurdly long one', async () => {
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO agent_runs (workspace_id, agent_key) VALUES (${workspaceA}, '')
          `),
        /agent_runs_agent_key_is_bounded/i,
      );

      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO agent_runs (workspace_id, agent_key)
            VALUES (${workspaceA}, ${'a'.repeat(101)})
          `),
        /agent_runs_agent_key_is_bounded/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // attribution_events composes with ADR-0012 rather than duplicating it
  // -------------------------------------------------------------------------

  describe('attribution events', () => {
    it('an unpublished draft cannot have caused anything', async () => {
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO attribution_events
              (workspace_id, agent_output_id, outcome, opportunity_id, occurred_at)
            VALUES (${workspaceA}, ${outputA}, 'opportunity_won', gen_random_uuid(), now())
          `),
        /never published|not visible/i,
      );
    });

    it('the outcome decides which target column must be set', async () => {
      // 'contact_created' with an opportunity target is incoherent: the row
      // would claim a contact was created and point at a deal.
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO attribution_events
              (workspace_id, agent_output_id, outcome, opportunity_id, occurred_at)
            VALUES (${workspaceA}, ${publishedOutputA}, 'contact_created', gen_random_uuid(), now())
          `),
        /attribution_events_target_matches_outcome/i,
      );

      // And a row with no target at all is refused rather than silently stored
      // as an attribution to nothing.
      await expectRefusal(
        () =>
          harness.owner.execute(sql`
            INSERT INTO attribution_events (workspace_id, agent_output_id, outcome, occurred_at)
            VALUES (${workspaceA}, ${publishedOutputA}, 'acquisition_recorded', now())
          `),
        /attribution_events_target_matches_outcome/i,
      );
    });

    it('a published output attributed to a real contact IS accepted', async () => {
      // The refusals above are only meaningful if a coherent row gets through.
      // Without this, a constraint that rejected everything would look healthy.
      const [event] = await harness.owner
        .insert(attributionEvents)
        .values({
          workspaceId: workspaceA,
          agentOutputId: publishedOutputA,
          outcome: 'contact_created',
          contactId: contactA,
          occurredAt: new Date('2026-03-11T00:00:00Z'),
        })
        .returning();

      expect(event!.contactId).toBe(contactA);
      expect(event!.acquisitionId).toBeNull();
      expect(event!.opportunityId).toBeNull();

      // And it is visible to its own tenant, through RLS, as a join.
      const joined = await inTenant(workspaceA, async (tx) => {
        const t = tx as unknown as typeof harness.app;
        return t.execute<{ kind: string; first_name: string }>(sql`
          SELECT o.kind, c.first_name
          FROM attribution_events e
          JOIN agent_outputs o ON o.id = e.agent_output_id
          JOIN contacts c      ON c.id = e.contact_id
          WHERE e.id = ${event!.id}
        `);
      });
      expect(joined).toHaveLength(1);
      expect(joined[0]?.first_name).toBe('Sarah');
    });

    it('⚠️ carries no channel columns — ADR-0012 owns provenance', async () => {
      // The failure this guards against is a later migration "helpfully"
      // denormalising UTM or source onto the join, producing a second set of
      // provenance values written by something that cannot observe them.
      const columns = await harness.owner.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'attribution_events'
      `);
      const names = columns.map((c) => c.column_name);

      for (const forbidden of [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'source_type',
        'source_platform',
        'confidence',
        'landing_path',
        'channel_detail',
      ]) {
        expect(names, `attribution_events has grown a ${forbidden} column`).not.toContain(
          forbidden,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // The deferral, held open by a test
  // -------------------------------------------------------------------------

  it('⚠️ no channel_credentials table exists — deferred to the connector phase', async () => {
    // ADR-0063 alternative B: there is no reversible-encryption primitive in
    // this repository, so a credential store here would mean inventing a
    // secrets pattern as a side effect of a schema task. If this test fails,
    // someone built it — and the ADR needs superseding first.
    const found = await harness.owner.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'channel_credentials'
    `);
    expect(found[0]?.count).toBe('0');
  });
});
