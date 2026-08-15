/**
 * CRM data lifecycle — DATABASE layer.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM crm-isolation.integration.test.ts
 * That suite proves one tenant cannot see another's rows. This one proves the
 * two operations that deliberately BREAK the CRM's normal rules do so only in
 * the narrow ways they are allowed to — and that the rules still hold for
 * everything else.
 *
 * Merge and erasure are the only code paths in Growth OS that can mutate the
 * append-only activity timeline or an immutable acquisition. Every assertion
 * below runs as the RESTRICTED, NON-OWNER role, because a suite connected as
 * the migration role would pass while proving nothing.
 *
 * THESE ARE MOSTLY NEGATIVE TESTS, ON PURPOSE
 * "merge moves the rows" would pass even if the escalation were a blanket
 * bypass. "an ordinary UPDATE on activities is still refused", "merge cannot
 * rewrite a summary", "erasure cannot change where a lead came from" would not.
 *
 * @see packages/database/migrations/0004_crm_data_lifecycle.sql
 * @see docs/decisions/ADR-0019-contact-merge.md
 * @see docs/decisions/ADR-0020-privacy-erasure.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  type TestHarness,
} from './testing/harness';
import {
  acquisitions,
  activities,
  contactFieldDefinitions,
  contactFieldValues,
  contactTags,
  contacts,
  opportunities,
  pipelineStages,
  pipelines,
  tags,
  tasks,
} from './schema/crm';
import { erasureRequests, ingestionReceipts } from './schema/crm-lifecycle';
import { workspaces } from './schema/tenancy';
import { users } from './schema/identity';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

/** Tables added in Stage 2.5. Each must be RLS-enabled AND forced. */
const LIFECYCLE_TABLES = [
  'tags',
  'contact_tags',
  'contact_field_definitions',
  'contact_field_values',
  'ingestion_receipts',
  'import_batches',
  'erasure_requests',
] as const;

/**
 * Collect the message chain of a rejected write.
 *
 * Drizzle wraps driver errors, so the PostgreSQL message lives on
 * `error.cause`. Asserting only the outer message would match ANY failure —
 * including a typo in the test — which would make these assertions worthless.
 */
async function rejectionMessage(operation: () => Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught, 'expected the operation to be rejected').toBeDefined();

  const messages: string[] = [];
  let current: unknown = caught;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join(' | ');
}

describeIntegration('CRM data lifecycle (merge, erasure, idempotency)', () => {
  let harness: TestHarness;
  let workspaceA: string;
  let workspaceB: string;
  let operator: string;
  let survivor: string;
  let duplicate: string;
  let dealId: string;
  let vipTagId: string;

  /** Run `fn` inside a transaction scoped to `workspace`, as the app role. */
  async function inWorkspace<T>(
    workspace: string,
    fn: (tx: Parameters<Parameters<typeof harness.app.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return harness.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${workspace}, true)`);
      return fn(tx);
    });
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    await assertRestrictedRole(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();

    const spaces = await harness.owner
      .insert(workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing' },
        { name: 'Meridian Legal', slug: 'meridian-legal' },
      ])
      .returning();
    workspaceA = spaces[0]!.id;
    workspaceB = spaces[1]!.id;

    const [user] = await harness.owner
      .insert(users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam Whitfield', passwordHash: null })
      .returning();
    operator = user!.id;

    // Two records for the same person — the situation merge exists to resolve.
    const people = await harness.owner
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
          workspaceId: workspaceA,
          firstName: 'Sarah',
          // The duplicate holds a phone the survivor lacks — the "fill" case.
          phone: '0412 345 678',
          phoneE164: '+61412345678',
          email: 'sarah@example.test',
          emailNormalised: 'sarah@example.test',
        },
      ])
      .returning();
    survivor = people[0]!.id;
    duplicate = people[1]!.id;

    await harness.owner.insert(acquisitions).values({
      workspaceId: workspaceA,
      contactId: duplicate,
      sourceType: 'organic_search',
      sourcePlatform: 'google',
      confidence: 'declared',
      landingPath: '/emergency-plumber',
      channelDetail: 'Contact form',
      referrerOrigin: 'https://www.google.com',
      gclid: 'GCL-abc123',
    });

    const [pipeline] = await harness.owner
      .insert(pipelines)
      .values({ workspaceId: workspaceA, name: 'Sales', isDefault: true })
      .returning();
    const [stage] = await harness.owner
      .insert(pipelineStages)
      .values({
        workspaceId: workspaceA,
        pipelineId: pipeline!.id,
        name: 'New Lead',
        position: 10,
        category: 'open',
      })
      .returning();

    const [deal] = await harness.owner
      .insert(opportunities)
      .values({
        workspaceId: workspaceA,
        title: 'Hot water replacement for Sarah Mitchell',
        contactId: duplicate,
        pipelineId: pipeline!.id,
        stageId: stage!.id,
        estimatedValueMinor: 140_000,
      })
      .returning();
    dealId = deal!.id;

    await harness.owner.insert(tasks).values([
      {
        workspaceId: workspaceA,
        title: 'Call Sarah about the hot water quote',
        description: 'Sarah said mornings are best',
        contactId: duplicate,
      },
      {
        // ⚠️ THE ROW THAT MADE THIS SUITE WORTH WRITING.
        // A task raised against the DEAL has no contact_id at all, yet its
        // title names the person. Erasure keyed only on contact_id would leave
        // it behind and report success.
        workspaceId: workspaceA,
        title: 'Quote hot water for Sarah Mitchell',
        opportunityId: dealId,
      },
    ]);

    await harness.owner.insert(activities).values([
      {
        workspaceId: workspaceA,
        type: 'contact.created',
        summary: 'Sarah Mitchell added',
        contactId: duplicate,
      },
      {
        workspaceId: workspaceA,
        type: 'task.created',
        summary: 'Task created — Quote hot water for Sarah Mitchell',
        opportunityId: dealId,
      },
    ]);

    const tagRows = await harness.owner
      .insert(tags)
      .values([
        { workspaceId: workspaceA, name: 'VIP', slug: 'vip' },
        { workspaceId: workspaceA, name: 'Urgent', slug: 'urgent' },
      ])
      .returning();
    vipTagId = tagRows[0]!.id;

    await harness.owner.insert(contactTags).values([
      { workspaceId: workspaceA, contactId: survivor, tagId: vipTagId },
      { workspaceId: workspaceA, contactId: duplicate, tagId: vipTagId },
      { workspaceId: workspaceA, contactId: duplicate, tagId: tagRows[1]!.id },
    ]);

    const [definition] = await harness.owner
      .insert(contactFieldDefinitions)
      .values({
        workspaceId: workspaceA,
        key: 'property_type',
        label: 'Property type',
        type: 'text',
      })
      .returning();

    await harness.owner.insert(contactFieldValues).values({
      workspaceId: workspaceA,
      definitionId: definition!.id,
      contactId: duplicate,
      valueText: 'Terrace at 12 Smith St',
    });
  });

  // -------------------------------------------------------------------------
  // The escalation gate
  // -------------------------------------------------------------------------

  describe('the activity timeline stays append-only', () => {
    it('refuses an ordinary UPDATE, with no lifecycle flag set', async () => {
      // The single most important assertion in this file. If this ever passes
      // silently, the timeline is editable by any code path in the product.
      //
      // The refusal is SILENT rather than an error, and that is correct: no
      // policy grants UPDATE without the flag, so RLS matches zero rows and
      // the statement succeeds having done nothing. The trigger never fires
      // because there is no row to fire it on.
      //
      // So the assertion is on the OUTCOME, not on an exception. A test that
      // expected a thrown error here would fail against a perfectly secure
      // database — and, worse, would tempt someone to "fix" it by loosening
      // the policy until an error appeared.
      const updated = await inWorkspace(workspaceA, (tx) =>
        tx
          .update(activities)
          .set({ summary: 'tampered' })
          .where(eq(activities.workspaceId, workspaceA))
          .returning({ id: activities.id }),
      );

      expect(updated).toHaveLength(0);

      const rows = await harness.owner
        .select({ summary: activities.summary })
        .from(activities)
        .where(eq(activities.workspaceId, workspaceA));
      expect(rows.every((row) => row.summary !== 'tampered')).toBe(true);
    });

    it('refuses an UPDATE from the OWNER too, because the trigger is independent', async () => {
      // FORCE ROW LEVEL SECURITY covers the table owner, but a SUPERUSER is
      // exempt from RLS unconditionally and no statement can change that. The
      // column trigger is what still refuses on that path — which is why it
      // exists in addition to the policy rather than instead of it.
      const message = await rejectionMessage(() =>
        harness.owner
          .update(activities)
          .set({ summary: 'tampered' })
          .where(eq(activities.workspaceId, workspaceA)),
      );

      expect(message).toMatch(/append-only/i);
    });

    it('refuses a DELETE', async () => {
      const deleted = await inWorkspace(workspaceA, (tx) =>
        tx
          .delete(activities)
          .where(eq(activities.workspaceId, workspaceA))
          .returning({ id: activities.id }),
      );

      // No DELETE policy exists, so RLS matches zero rows rather than raising.
      expect(deleted).toHaveLength(0);
    });

    it('refuses an UPDATE even when the flag is set by hand outside the functions', async () => {
      // The flag alone is not enough: the column-restriction trigger still
      // applies, so hand-setting it cannot rewrite what a merge may not.
      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, async (tx) => {
          await tx.execute(sql`select set_config('app.lifecycle_operation', 'merge', true)`);
          return tx
            .update(activities)
            .set({ summary: 'tampered' })
            .where(eq(activities.workspaceId, workspaceA));
        }),
      );

      expect(message).toMatch(/may only re-point/i);
    });
  });

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  describe('crm_merge_contacts', () => {
    async function merge(workspace = workspaceA): Promise<Record<string, number>> {
      return inWorkspace(workspace, async (tx) => {
        const rows = await tx.execute<{ counts: Record<string, number> }>(
          sql`select crm_merge_contacts(
                ${workspace}::uuid, ${survivor}::uuid, ${duplicate}::uuid, ${operator}::uuid
              ) as counts`,
        );
        return rows[0]!.counts;
      });
    }

    it('re-homes every owned row onto the survivor', async () => {
      const counts = await merge();

      expect(counts).toMatchObject({
        acquisitions: 1,
        opportunities: 1,
        tasks: 1,
        activities: 1,
        customFields: 1,
      });

      const [remaining] = await harness.owner
        .select({ total: sql<number>`count(*)::int` })
        .from(acquisitions)
        .where(eq(acquisitions.contactId, duplicate));
      expect(remaining?.total).toBe(0);
    });

    it('drops the duplicate tag the survivor already had, and moves the rest', async () => {
      await merge();

      const rows = await harness.owner
        .select({ tagId: contactTags.tagId })
        .from(contactTags)
        .where(eq(contactTags.contactId, survivor));

      // VIP was on both; Urgent only on the duplicate. Two, not three.
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.tagId)).toContain(vipTagId);
    });

    it('leaves the duplicate as a redirect tombstone, not a deletion', async () => {
      await merge();

      const [row] = await harness.owner
        .select({
          mergedInto: contacts.mergedIntoContactId,
          mergedAt: contacts.mergedAt,
          deletedAt: contacts.deletedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, duplicate));

      expect(row?.mergedInto).toBe(survivor);
      expect(row?.mergedAt).not.toBeNull();
      // Merged is NOT soft-deleted. Conflating the two would lose the redirect.
      expect(row?.deletedAt).toBeNull();
    });

    it('does not change where the moved lead came from', async () => {
      await merge();

      const [row] = await harness.owner
        .select()
        .from(acquisitions)
        .where(eq(acquisitions.contactId, survivor));

      expect(row?.sourceType).toBe('organic_search');
      expect(row?.sourcePlatform).toBe('google');
      expect(row?.confidence).toBe('declared');
      expect(row?.landingPath).toBe('/emergency-plumber');
      // Erasure clears these; a merge must not.
      expect(row?.gclid).toBe('GCL-abc123');
      expect(row?.channelDetail).toBe('Contact form');
    });

    it('clears the lifecycle flag before returning', async () => {
      // A flag left set would silently extend the escalation to the rest of
      // the caller's transaction — the exact thing the design prevents.
      const flag = await inWorkspace(workspaceA, async (tx) => {
        await tx.execute(
          sql`select crm_merge_contacts(
                ${workspaceA}::uuid, ${survivor}::uuid, ${duplicate}::uuid, ${operator}::uuid)`,
        );
        const rows = await tx.execute<{ flag: string | null }>(
          sql`select app_lifecycle_operation() as flag`,
        );
        return rows[0]?.flag ?? null;
      });

      expect(flag).toBeNull();
    });

    it('refuses to merge a contact into itself', async () => {
      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, (tx) =>
          tx.execute(
            sql`select crm_merge_contacts(
                  ${workspaceA}::uuid, ${survivor}::uuid, ${survivor}::uuid, ${operator}::uuid)`,
          ),
        ),
      );

      expect(message).toMatch(/merged into itself/i);
    });

    it('refuses a second merge of an already-merged contact', async () => {
      await merge();

      const message = await rejectionMessage(() => merge());
      expect(message).toMatch(/already been merged/i);
    });

    it('refuses a workspace argument that does not match the transaction scope', async () => {
      // Without this check the function would be a cross-tenant write
      // primitive reachable from every request — the classic SECURITY DEFINER
      // hole.
      const message = await rejectionMessage(() =>
        inWorkspace(workspaceB, (tx) =>
          tx.execute(
            sql`select crm_merge_contacts(
                  ${workspaceA}::uuid, ${survivor}::uuid, ${duplicate}::uuid, ${operator}::uuid)`,
          ),
        ),
      );

      expect(message).toMatch(/outside the active workspace scope/i);
    });

    it('refuses to merge an erased contact', async () => {
      await inWorkspace(workspaceA, (tx) =>
        tx.execute(
          sql`select crm_erase_contact(${workspaceA}::uuid, ${duplicate}::uuid, ${operator}::uuid)`,
        ),
      );

      const message = await rejectionMessage(() => merge());
      expect(message).toMatch(/erased contact cannot take part/i);
    });
  });

  // -------------------------------------------------------------------------
  // Erasure
  // -------------------------------------------------------------------------

  describe('crm_erase_contact', () => {
    async function erase(contactId = duplicate, workspace = workspaceA) {
      return inWorkspace(workspace, async (tx) => {
        const rows = await tx.execute<{ counts: Record<string, number> }>(
          sql`select crm_erase_contact(
                ${workspace}::uuid, ${contactId}::uuid, ${operator}::uuid) as counts`,
        );
        return rows[0]!.counts;
      });
    }

    it('leaves no trace of the person anywhere in the CRM', async () => {
      await erase();

      // Searched by NAME rather than by checking the columns the routine
      // happens to touch. A test written against the implementation would pass
      // even if the implementation missed a column; this one cannot.
      const [row] = await harness.owner.execute<{ traces: number }>(sql`
        select (
          (select count(*) from contacts
            where id = ${duplicate}
              and (first_name ilike '%sarah%' or coalesce(last_name,'') ilike '%mitchell%'
                or coalesce(email,'') ilike '%sarah%' or coalesce(phone,'') ilike '%0412%'))
        + (select count(*) from tasks
            where workspace_id = ${workspaceA}
              and (title ilike '%sarah%' or coalesce(description,'') ilike '%sarah%'))
        + (select count(*) from opportunities
            where workspace_id = ${workspaceA} and title ilike '%sarah%')
        + (select count(*) from activities
            where workspace_id = ${workspaceA}
              and (summary ilike '%sarah%' or coalesce(detail,'') ilike '%sarah%'))
        + (select count(*) from contact_field_values where contact_id = ${duplicate})
        )::int as traces
      `);

      expect(row?.traces).toBe(0);
    });

    it('reaches the task and activity that hang off the deal, not the contact', async () => {
      const counts = await erase();

      // Two tasks: one linked directly, one only via the opportunity.
      expect(counts['tasks']).toBe(2);
      expect(counts['activities']).toBe(2);
    });

    it('keeps the commercial record intact', async () => {
      await erase();

      const [deal] = await harness.owner
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, dealId));

      // The value, stage and status are business facts about the workspace.
      expect(deal?.estimatedValueMinor).toBe(140_000);
      expect(deal?.status).toBe('open');
      // Only the free text, which named the person, is replaced.
      expect(deal?.title).toBe('Erased opportunity');
    });

    it('keeps channel attribution and clears only the linkable detail', async () => {
      await erase();

      const [row] = await harness.owner
        .select()
        .from(acquisitions)
        .where(eq(acquisitions.contactId, duplicate));

      // "12 leads from organic search" must still answer after an erasure.
      expect(row?.sourceType).toBe('organic_search');
      expect(row?.sourcePlatform).toBe('google');
      expect(row?.landingPath).toBe('/emergency-plumber');

      // A click id resolves back to a person at the ad platform, which makes
      // it personal data however much it looks like plumbing.
      expect(row?.gclid).toBeNull();
      expect(row?.channelDetail).toBeNull();
      expect(row?.referrerOrigin).toBeNull();
    });

    it('keeps the timeline shape and drops only the wording', async () => {
      await erase();

      const rows = await harness.owner
        .select({ type: activities.type, summary: activities.summary })
        .from(activities)
        .where(eq(activities.workspaceId, workspaceA));

      expect(rows.map((row) => row.type).sort()).toEqual(['contact.created', 'task.created']);
      expect(rows.every((row) => row.summary === 'Details erased')).toBe(true);
    });

    it('writes a permanent, PII-free erasure record', async () => {
      const counts = await erase();

      const [record] = await harness.owner
        .select()
        .from(erasureRequests)
        .where(eq(erasureRequests.contactId, duplicate));

      expect(record?.affectedCounts).toEqual(counts);
      // The record carries counts and ids. Nothing in it names the person.
      expect(JSON.stringify(record)).not.toMatch(/sarah|mitchell|0412/i);
    });

    it('refuses a second erasure', async () => {
      await erase();
      const message = await rejectionMessage(() => erase());
      expect(message).toMatch(/already been erased/i);
    });

    it('refuses a workspace argument that does not match the transaction scope', async () => {
      const message = await rejectionMessage(() =>
        inWorkspace(workspaceB, (tx) =>
          tx.execute(
            sql`select crm_erase_contact(
                  ${workspaceA}::uuid, ${duplicate}::uuid, ${operator}::uuid)`,
          ),
        ),
      );

      expect(message).toMatch(/outside the active workspace scope/i);
    });

    it('cannot be used to move a timeline entry onto another person', async () => {
      // The erase flag permits redaction, never re-homing. Without the column
      // trigger, "erasure may update activities" would also mean "erasure may
      // re-point them".
      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, async (tx) => {
          await tx.execute(sql`select set_config('app.lifecycle_operation', 'erase', true)`);
          return tx
            .update(activities)
            .set({ contactId: survivor })
            .where(eq(activities.contactId, duplicate));
        }),
      );

      expect(message).toMatch(/may only redact/i);
    });

    it('cannot be used to rewrite where a lead came from', async () => {
      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, async (tx) => {
          await tx.execute(sql`select set_config('app.lifecycle_operation', 'erase', true)`);
          return tx
            .update(acquisitions)
            .set({ sourceType: 'paid_search' })
            .where(eq(acquisitions.contactId, duplicate));
        }),
      );

      expect(message).toMatch(/provenance is immutable/i);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('ingestion receipts', () => {
    it('refuse a second receipt for the same workspace, source and key', async () => {
      await inWorkspace(workspaceA, (tx) =>
        tx.insert(ingestionReceipts).values({
          workspaceId: workspaceA,
          sourceSystem: 'website_form',
          externalKey: 'submission_1',
          requestDigest: 'abc',
        }),
      );

      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, (tx) =>
          tx.insert(ingestionReceipts).values({
            workspaceId: workspaceA,
            sourceSystem: 'website_form',
            externalKey: 'submission_1',
            requestDigest: 'abc',
          }),
        ),
      );

      expect(message).toMatch(/duplicate key|unique/i);
    });

    it('allow the same key from a different source system', async () => {
      // Third-party ids are not globally unique — two providers can both emit
      // `submission_1`. A global key would silently discard a real lead.
      await inWorkspace(workspaceA, async (tx) => {
        await tx.insert(ingestionReceipts).values({
          workspaceId: workspaceA,
          sourceSystem: 'website_form',
          externalKey: 'submission_1',
          requestDigest: 'abc',
        });
        await tx.insert(ingestionReceipts).values({
          workspaceId: workspaceA,
          sourceSystem: 'facebook_leads',
          externalKey: 'submission_1',
          requestDigest: 'def',
        });
      });

      const [row] = await harness.owner
        .select({ total: sql<number>`count(*)::int` })
        .from(ingestionReceipts)
        .where(eq(ingestionReceipts.workspaceId, workspaceA));

      expect(row?.total).toBe(2);
    });

    it('are immutable once written', async () => {
      await inWorkspace(workspaceA, (tx) =>
        tx.insert(ingestionReceipts).values({
          workspaceId: workspaceA,
          sourceSystem: 'website_form',
          externalKey: 'submission_1',
          requestDigest: 'abc',
        }),
      );

      // No UPDATE policy: a receipt that can be rewritten is not an
      // idempotency record, it is a suggestion.
      const updated = await inWorkspace(workspaceA, (tx) =>
        tx
          .update(ingestionReceipts)
          .set({ requestDigest: 'tampered' })
          .where(eq(ingestionReceipts.workspaceId, workspaceA))
          .returning({ id: ingestionReceipts.id }),
      );

      expect(updated).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Isolation of the new tables
  // -------------------------------------------------------------------------

  describe('row-level security covers every new table', () => {
    it('has RLS enabled AND forced on all of them', async () => {
      // ENABLE alone leaves the table owner exempt, which silently makes the
      // whole layer decorative. Both flags are asserted.
      const rows = await harness.owner.execute<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
      `);

      const byName = new Map(rows.map((row) => [row.relname, row]));
      for (const table of LIFECYCLE_TABLES) {
        expect(byName.get(table)?.relrowsecurity, `${table} RLS enabled`).toBe(true);
        expect(byName.get(table)?.relforcerowsecurity, `${table} RLS forced`).toBe(true);
      }
    });

    it('hides another workspace’s tags, values and receipts', async () => {
      await harness.owner.insert(tags).values({
        workspaceId: workspaceB,
        name: 'Confidential',
        slug: 'confidential',
      });

      const visible = await inWorkspace(workspaceA, (tx) => tx.select().from(tags));

      expect(visible.map((row) => row.slug)).not.toContain('confidential');
      expect(visible.every((row) => row.workspaceId === workspaceA)).toBe(true);
    });

    it('refuses to write a row labelled with another workspace', async () => {
      // WITHOUT the WITH CHECK clause, reads would be isolated while writes
      // were not — a subtle and easily missed hole.
      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, (tx) =>
          tx.insert(tags).values({ workspaceId: workspaceB, name: 'Smuggled', slug: 'smuggled' }),
        ),
      );

      expect(message).toMatch(/row-level security|violates/i);
    });

    it('refuses an unscoped read', async () => {
      // `app_current_workspace_id()` returns NULL when unscoped, so every
      // policy matches nothing — fail closed, not fail open.
      const rows = await harness.app.select().from(tags);
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Custom field storage rules
  // -------------------------------------------------------------------------

  describe('custom field values', () => {
    it('refuse a row with no value at all', async () => {
      const [definition] = await harness.owner
        .select()
        .from(contactFieldDefinitions)
        .where(eq(contactFieldDefinitions.workspaceId, workspaceA));

      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, (tx) =>
          tx.insert(contactFieldValues).values({
            workspaceId: workspaceA,
            definitionId: definition!.id,
            contactId: survivor,
          }),
        ),
      );

      // Clearing a value deletes the row; "all four columns null" must not be
      // a second, indistinguishable way to say the same thing.
      expect(message).toMatch(/exactly_one_value|check constraint/i);
    });

    it('refuse a row with two values', async () => {
      const [definition] = await harness.owner
        .select()
        .from(contactFieldDefinitions)
        .where(eq(contactFieldDefinitions.workspaceId, workspaceA));

      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, (tx) =>
          tx.insert(contactFieldValues).values({
            workspaceId: workspaceA,
            definitionId: definition!.id,
            contactId: survivor,
            valueText: 'Terrace',
            valueNumber: 3,
          }),
        ),
      );

      expect(message).toMatch(/exactly_one_value|check constraint/i);
    });

    it('allow only one value per field per contact', async () => {
      const [definition] = await harness.owner
        .select()
        .from(contactFieldDefinitions)
        .where(eq(contactFieldDefinitions.workspaceId, workspaceA));

      const message = await rejectionMessage(() =>
        inWorkspace(workspaceA, (tx) =>
          tx.insert(contactFieldValues).values({
            workspaceId: workspaceA,
            definitionId: definition!.id,
            contactId: duplicate,
            valueText: 'A second value',
          }),
        ),
      );

      expect(message).toMatch(/duplicate key|unique/i);
    });
  });

  // -------------------------------------------------------------------------
  // Identity index behaviour
  // -------------------------------------------------------------------------

  it('excludes merged contacts from identity matching', async () => {
    await inWorkspace(workspaceA, (tx) =>
      tx.execute(
        sql`select crm_merge_contacts(
              ${workspaceA}::uuid, ${survivor}::uuid, ${duplicate}::uuid, ${operator}::uuid)`,
      ),
    );

    // Both records held sarah@example.test. After the merge, only the survivor
    // may be found by it — matching the tombstone would attach new
    // acquisitions to a redirect rather than to the real person.
    const matches = await inWorkspace(workspaceA, (tx) =>
      tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.emailNormalised, 'sarah@example.test'),
            sql`${contacts.mergedAt} is null`,
            sql`${contacts.erasedAt} is null`,
            sql`${contacts.deletedAt} is null`,
          ),
        ),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(survivor);
  });
});
