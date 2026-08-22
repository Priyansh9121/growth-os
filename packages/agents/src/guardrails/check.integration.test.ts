/**
 * The guardrail service against a real database.
 *
 * WHY THIS SUITE EXISTS
 * `@growth-os/guardrails` is pure and was tested against corpora handed to it
 * by the test. ADR-0064 recorded the gap that leaves: _"nothing stops a caller
 * passing an incomplete corpus, and a check that compares against nothing
 * returns `pass`"_. This is the first code that assembles a corpus from
 * storage, so it is the first place that risk is real — and the first place it
 * can be proven handled.
 *
 * Every test runs through `harness.app`, the RESTRICTED role. A superuser or
 * table owner is EXEMPT from row-level security, so a suite connected as the
 * migration role would pass while proving nothing about isolation.
 *
 * @see docs/decisions/ADR-0065-guardrail-corpus-assembly.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@growth-os/database';
import type { TenantActor, WorkspaceRole } from '@growth-os/contracts';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  type TestHarness,
} from '@growth-os/database/testing';
import { agentOutputs, agentRuns, users, workspaces } from '@growth-os/database/schema';
import { checkProposedOutput } from './check';
import type { AgentsContext } from '../shared/context';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

/** ~60 words: comfortably over the guardrail's 40-word floor. */
const LONG_BODY =
  'When your boiler fails in the middle of winter you need someone fast. Our Gas Safe engineers cover the whole of Leeds and are usually with you within two hours. We charge a flat callout fee with no hidden extras, and we will always quote before starting work, because a surprise on the invoice loses a customer.';

/** A genuinely different draft of comparable length. */
const OTHER_BODY =
  'Five questions to ask a conveyancing solicitor before you instruct one. Buying a house is the largest transaction most people ever make, so ask how they charge, who will actually handle your file day to day, how quickly they answer the phone, whether they sit on your lender panel, and what happens if the chain collapses.';

describeIntegration('checkProposedOutput', () => {
  let harness: TestHarness;
  let workspaceA: string;
  let workspaceB: string;
  let userA: string;
  let runA: string;
  let runB: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    await assertRestrictedRole(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  function contextFor(workspace: string, role: WorkspaceRole = 'member'): AgentsContext {
    const access = {
      workspaceId: workspace,
      workspaceName: 'ABC Plumbing',
      workspaceSlug: 'abc-plumbing',
      agencyId: null,
      role,
      via: 'direct' as const,
    };
    const tenant: TenantActor = {
      actor: {
        userId: userA,
        email: 'sam@abcplumbing.test',
        name: 'Sam Whitfield',
        sessionId: 'test-session',
        workspaces: [access],
        agencies: [],
      },
      workspace: access,
    };
    return {
      deps: { db: harness.app as unknown as Database },
      tenant,
      correlationId: 'test-correlation',
    };
  }

  /** Insert a published output as OWNER, so setup is not what is being tested. */
  async function publish(workspace: string, run: string, body: string, when: string) {
    const [row] = await harness.owner
      .insert(agentOutputs)
      .values({
        workspaceId: workspace,
        agentRunId: run,
        kind: 'blog_post',
        content: { body },
        publishedAt: new Date(when),
      })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await harness.truncate();

    const insertedWorkspaces = await harness.owner
      .insert(workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing' },
        { name: 'Meridian Legal', slug: 'meridian-legal' },
      ])
      .returning();
    workspaceA = insertedWorkspaces[0]!.id;
    workspaceB = insertedWorkspaces[1]!.id;

    const [user] = await harness.owner
      .insert(users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam Whitfield', passwordHash: null })
      .returning();
    userA = user!.id;

    const runs = await harness.owner
      .insert(agentRuns)
      .values([
        { workspaceId: workspaceA, agentKey: 'seo-brief' },
        { workspaceId: workspaceB, agentKey: 'seo-brief' },
      ])
      .returning();
    runA = runs[0]!.id;
    runB = runs[1]!.id;
  });

  describe('the capability gate', () => {
    it('a viewer is refused — workspace:ai:query is not theirs', async () => {
      await expect(
        checkProposedOutput(
          contextFor(workspaceA, 'viewer'),
          {
            kind: 'blog_post',
            content: { body: LONG_BODY },
          },
          { priorLimit: 100 },
        ),
      ).rejects.toThrow(/workspace:ai:query/);
    });

    it('a member is allowed', async () => {
      const result = await checkProposedOutput(
        contextFor(workspaceA, 'member'),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 100 },
      );
      expect(result.report.outcome).toBe('pass');
    });

    it('⚠️ the capability is checked BEFORE the database is touched', async () => {
      // A refused caller must not be able to make the service run a count over
      // another tenant's table as a side effect.
      await publish(workspaceA, runA, LONG_BODY, '2026-03-01T00:00:00Z');
      const result = await checkProposedOutput(
        contextFor(workspaceA, 'viewer'),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 100 },
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
    });
  });

  describe('⚠️ the corpus is the tenant’s own, and nothing else', () => {
    it('another workspace’s published output is never compared against', async () => {
      // The identical body is published in workspace B. If it leaked into A's
      // corpus the verdict would be `fail`; RLS plus the query predicate mean
      // it is not even counted.
      await publish(workspaceB, runB, LONG_BODY, '2026-03-01T00:00:00Z');

      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 100 },
      );

      expect(result.corpus.totalPublished).toBe(0);
      expect(result.corpus.compared).toBe(0);
      expect(result.report.outcome).toBe('pass');
    });

    it('the workspace’s own duplicate IS caught', async () => {
      // The mirror of the test above: same body, same workspace, and now it
      // must fail. Without this, the isolation test would pass even if the
      // service never compared anything at all.
      const priorId = await publish(workspaceA, runA, LONG_BODY, '2026-03-01T00:00:00Z');

      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 100 },
      );

      expect(result.report.outcome).toBe('fail');
      expect(result.report.findings[0]?.message).toContain(priorId);
      expect(result.corpus.compared).toBe(1);
    });
  });

  describe('unpublished drafts are not part of the corpus', () => {
    it('a draft that was never published is neither counted nor compared', async () => {
      await harness.owner.insert(agentOutputs).values({
        workspaceId: workspaceA,
        agentRunId: runA,
        kind: 'blog_post',
        content: { body: LONG_BODY },
        publishedAt: null,
      });

      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 100 },
      );

      expect(result.corpus.totalPublished).toBe(0);
      expect(result.report.outcome).toBe('pass');
    });
  });

  describe('⚠️ a pass over a truncated corpus is not a pass', () => {
    beforeEach(async () => {
      // Five published priors, none matching the proposed draft.
      for (let i = 0; i < 5; i += 1) {
        await publish(
          workspaceA,
          runA,
          `${OTHER_BODY} Reference number ${i} for the ${i} instruction taken this month.`,
          `2026-03-0${i + 1}T00:00:00Z`,
        );
      }
    });

    it('reports the truncation and downgrades pass to indeterminate', async () => {
      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 2 },
      );

      expect(result.corpus).toMatchObject({
        totalPublished: 5,
        compared: 2,
        truncated: true,
        limit: 2,
      });
      expect(result.report.outcome).toBe('indeterminate');
      expect(result.report.findings.map((f) => f.check)).toContain('corpus-completeness');
    });

    it('an untruncated corpus passes cleanly', async () => {
      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 5 },
      );
      expect(result.corpus.truncated).toBe(false);
      expect(result.report.outcome).toBe('pass');
      expect(result.report.findings).toEqual([]);
    });

    it('⚠️ the off-by-one boundary: limit 4 truncates, limit 5 does not', async () => {
      // `rows.length === limit` cannot distinguish "exactly the limit" from
      // "more than the limit", which is why the count is taken separately.
      // Five priors exist; this pins both sides of the boundary.
      const draft = { kind: 'blog_post', content: { body: LONG_BODY } };

      const under = await checkProposedOutput(contextFor(workspaceA), draft, { priorLimit: 4 });
      expect(under.corpus).toMatchObject({ totalPublished: 5, compared: 4, truncated: true });
      expect(under.report.outcome).toBe('indeterminate');

      const exact = await checkProposedOutput(contextFor(workspaceA), draft, { priorLimit: 5 });
      expect(exact.corpus).toMatchObject({ totalPublished: 5, compared: 5, truncated: false });
      expect(exact.report.outcome).toBe('pass');
    });

    it('⚠️ a FAIL is never downgraded by truncation', async () => {
      // Truncation can only hide matches, never invent one. A duplicate found
      // against a partial corpus is still a duplicate.
      await publish(workspaceA, runA, LONG_BODY, '2026-03-09T00:00:00Z');

      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 1 },
      );

      expect(result.corpus.truncated).toBe(true);
      expect(result.report.outcome).toBe('fail');
      expect(result.report.findings.map((f) => f.check)).not.toContain('corpus-completeness');
    });

    it('newest priors are fetched first, so truncation keeps the most relevant', async () => {
      await publish(workspaceA, runA, LONG_BODY, '2026-03-20T00:00:00Z');
      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 1 },
      );
      // The single fetched prior is the newest one, which is the duplicate.
      expect(result.report.outcome).toBe('fail');
    });
  });

  describe('priorLimit is required and must be sane', () => {
    it.each([0, -1, 1.5, Number.NaN])('refuses priorLimit %s', async (limit) => {
      // A limit of 0 would fetch nothing and report `pass` against an empty
      // corpus — the exact failure this service exists to prevent.
      await expect(
        checkProposedOutput(
          contextFor(workspaceA),
          { kind: 'blog_post', content: { body: LONG_BODY } },
          { priorLimit: limit },
        ),
      ).rejects.toThrow(RangeError);
    });
  });

  describe('the proposed output need not exist in the database', () => {
    it('checks a draft that was never persisted', async () => {
      await publish(workspaceA, runA, LONG_BODY, '2026-03-01T00:00:00Z');

      const before = await harness.owner.select().from(agentOutputs);
      const result = await checkProposedOutput(
        contextFor(workspaceA),
        { kind: 'blog_post', content: { body: LONG_BODY } },
        { priorLimit: 10 },
      );
      const after = await harness.owner.select().from(agentOutputs);

      // This is the whole point of the guardrails package being pure: the
      // check runs BEFORE the row exists, which is when it is still cheap.
      expect(result.report.outcome).toBe('fail');
      expect(after.length).toBe(before.length);
    });
  });
});
