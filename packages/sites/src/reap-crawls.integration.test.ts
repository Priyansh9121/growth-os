/**
 * Reaping crawls abandoned by a dead worker.
 *
 * ⚠️ THE CENTRAL RISK IS A REAPER THAT SILENTLY DOES NOTHING.
 * `crawls` and `crawl_frontier` are RLS `ENABLE` and `FORCE`. A sweep written
 * the way `reclaimStalledJobs` is written — one unscoped UPDATE — affects zero
 * rows under the restricted role, forever, and looks exactly like a system with
 * no stale crawls. So the first test here asserts that the unscoped shape
 * genuinely fails, and every other test runs as the RESTRICTED role.
 *
 * A suite that only ran as the owner would pass against a reaper that cannot
 * work in production (§6).
 *
 * @see docs/decisions/ADR-0055-reaping-abandoned-crawls.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, lt } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  withUnscopedTransaction,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { crawlStaleAfter, reapAbandonedCrawls } from './crawls';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;
const { crawlFrontier, crawls, sites, workspaces } = schemaTables;

const ORIGIN = 'https://example.test';
const PAGE_LIMIT = 10;

/** Just past the derived threshold for a PAGE_LIMIT-page crawl. */
const STALE_MS = PAGE_LIMIT * 30_000 + 30 * 60 * 1000 + 60_000;

describeIntegration('reaping abandoned crawls', () => {
  let harness: TestHarness;
  let db: Database;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let siteId: string;
  let otherSiteId: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    await assertRestrictedRole(harness);
    db = harness.app as unknown as Database;
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    const [w] = await harness.owner
      .insert(workspaces)
      .values({ name: 'Example', slug: 'example' })
      .returning();
    workspaceId = w!.id;
    const [other] = await harness.owner
      .insert(workspaces)
      .values({ name: 'Other', slug: 'other' })
      .returning();
    otherWorkspaceId = other!.id;

    const [s] = await harness.owner
      .insert(sites)
      .values({ workspaceId, name: 'Main', origin: ORIGIN })
      .returning();
    siteId = s!.id;
    const [os] = await harness.owner
      .insert(sites)
      .values({ workspaceId: otherWorkspaceId, name: 'Theirs', origin: 'https://other.test' })
      .returning();
    otherSiteId = os!.id;
  });

  /** A `running` crawl that started `agoMs` ago. */
  async function runningCrawl(
    agoMs: number,
    workspace = workspaceId,
    site = siteId,
  ): Promise<string> {
    const startedAt = new Date(Date.now() - agoMs);
    const [row] = await harness.owner
      .insert(crawls)
      .values({
        workspaceId: workspace,
        siteId: site,
        status: 'running',
        trigger: 'manual',
        origin: ORIGIN,
        pageLimit: PAGE_LIMIT,
        maxDepth: 3,
        startedAt,
        createdAt: startedAt,
      })
      .returning();
    return row!.id;
  }

  const crawlRow = async (id: string) =>
    (await harness.owner.select().from(crawls).where(eq(crawls.id, id)))[0];

  // -------------------------------------------------------------------------

  describe('⚠️ why this is not shaped like reclaimStalledJobs', () => {
    it('the unscoped UPDATE — the copied shape — affects ZERO rows', async () => {
      await runningCrawl(STALE_MS);

      // Exactly what `reclaimStalledJobs` does, against an RLS-FORCE table.
      const affected = await db
        .update(crawls)
        .set({ status: 'failed', failureCategory: 'internal_error', completedAt: new Date() })
        .where(and(eq(crawls.status, 'running'), lt(crawls.startedAt, new Date())))
        .returning({ id: crawls.id });

      // If this ever returns rows, either RLS was disabled or the app is
      // connecting as an exempt role — and this reaper's whole design premise
      // has changed. That is worth failing a build over.
      expect(affected).toHaveLength(0);
    });

    it('withUnscopedTransaction does not rescue it either', async () => {
      await runningCrawl(STALE_MS);
      // It leaves app_current_workspace_id() null, so the tenant policy matches
      // nothing. "Unscoped" is not "exempt".
      const seen = await withUnscopedTransaction(
        db,
        async (tx) => (await tx.select().from(crawls)).length,
      );
      expect(seen).toBe(0);
    });

    it('the real reaper, on the same row, DOES reap it', async () => {
      const crawlId = await runningCrawl(STALE_MS);
      const reaped = await reapAbandonedCrawls(db, new Date());
      expect(reaped.map((r) => r.crawlId)).toEqual([crawlId]);
    });
  });

  // -------------------------------------------------------------------------

  describe('what a reaped crawl looks like', () => {
    it('is failed, with internal_error, completedAt and an honest detail', async () => {
      const crawlId = await runningCrawl(STALE_MS);
      await reapAbandonedCrawls(db, new Date());

      const row = await crawlRow(crawlId);
      expect(row?.status).toBe('failed');
      expect(row?.failureCategory).toBe('internal_error');
      expect(row?.completedAt).not.toBeNull();
      expect(row?.failureDetail).toBe(
        'The crawl stopped responding and was marked failed automatically.',
      );
      // Safe for a customer: no host, no query, no stack trace.
      expect(row?.failureDetail).not.toContain(ORIGIN);
      expect(row?.failureDetail).not.toContain('    at ');
    });

    it('keeps startedAt, because when it began is still true', async () => {
      const crawlId = await runningCrawl(STALE_MS);
      const before = await crawlRow(crawlId);
      await reapAbandonedCrawls(db, new Date());
      expect((await crawlRow(crawlId))?.startedAt?.getTime()).toBe(before?.startedAt?.getTime());
    });

    it('does NOT retry it — a reaped crawl stays failed across passes', async () => {
      const crawlId = await runningCrawl(STALE_MS);
      await reapAbandonedCrawls(db, new Date());
      const second = await reapAbandonedCrawls(db, new Date());

      expect(second).toHaveLength(0);
      expect((await crawlRow(crawlId))?.status).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------

  describe('⚠️ a crawl that is genuinely still working is left alone', () => {
    it('leaves a crawl that started a moment ago untouched', async () => {
      const crawlId = await runningCrawl(1_000);
      expect(await reapAbandonedCrawls(db, new Date())).toHaveLength(0);
      expect((await crawlRow(crawlId))?.status).toBe('running');
    });

    it('leaves one just INSIDE its derived threshold', async () => {
      // 35 minutes for a 10-page crawl. A fixed 10-minute constant — the job
      // reaper's STALLED_MS — would have killed this one.
      const crawlId = await runningCrawl(PAGE_LIMIT * 30_000 + 30 * 60 * 1000 - 60_000);
      expect(await reapAbandonedCrawls(db, new Date())).toHaveLength(0);
      expect((await crawlRow(crawlId))?.status).toBe('running');
    });

    it('scales the threshold with the crawl’s own budget', async () => {
      // Same age, different budgets. The small one is past its bound; the large
      // one could still legitimately be fetching.
      const age = 40 * 60 * 1000;
      const small = await runningCrawl(age);
      const [big] = await harness.owner
        .insert(crawls)
        .values({
          workspaceId,
          siteId,
          status: 'running',
          trigger: 'manual',
          origin: ORIGIN,
          pageLimit: 5000,
          maxDepth: 3,
          startedAt: new Date(Date.now() - age),
          createdAt: new Date(Date.now() - age),
        })
        .returning();

      const reaped = await reapAbandonedCrawls(db, new Date());
      expect(reaped.map((r) => r.crawlId)).toEqual([small]);
      expect((await crawlRow(big!.id))?.status).toBe('running');
    });

    it.each(['queued', 'completed', 'failed', 'cancelled'] as const)(
      'never touches a %s crawl however old',
      async (status) => {
        const startedAt = status === 'queued' ? null : new Date(Date.now() - STALE_MS * 10);
        const [row] = await harness.owner
          .insert(crawls)
          .values({
            workspaceId,
            siteId,
            status,
            trigger: 'manual',
            origin: ORIGIN,
            pageLimit: PAGE_LIMIT,
            maxDepth: 3,
            startedAt,
            createdAt: new Date(Date.now() - STALE_MS * 10),
            ...(status === 'failed' ? { failureCategory: 'http_5xx' as const } : {}),
            ...(status === 'completed' || status === 'failed' || status === 'cancelled'
              ? { completedAt: new Date() }
              : {}),
          })
          .returning();

        expect(await reapAbandonedCrawls(db, new Date())).toHaveLength(0);
        expect((await crawlRow(row!.id))?.status).toBe(status);
      },
    );
  });

  // -------------------------------------------------------------------------

  describe('the frontier of a reaped crawl', () => {
    async function frontierRow(
      crawlId: string,
      url: string,
      state: 'queued' | 'fetching' | 'fetched',
    ) {
      await harness.owner.insert(crawlFrontier).values({
        workspaceId,
        crawlId,
        normalisedUrl: url,
        state,
        depth: 0,
      });
    }

    it('marks queued AND fetching rows skipped/abandoned', async () => {
      const crawlId = await runningCrawl(STALE_MS);
      await frontierRow(crawlId, `${ORIGIN}/a`, 'queued');
      await frontierRow(crawlId, `${ORIGIN}/b`, 'fetching');

      const [reaped] = await reapAbandonedCrawls(db, new Date());
      expect(reaped?.frontierAbandoned).toBe(2);

      const rows = await harness.owner
        .select()
        .from(crawlFrontier)
        .where(eq(crawlFrontier.crawlId, crawlId));

      for (const row of rows) {
        expect(row.state).toBe('skipped');
        // ⚠️ NOT `cancelled`. Nobody decided to stop; a process died.
        expect(row.skipReason).toBe('abandoned');
      }
    });

    it('⚠️ includes `fetching`, which finishCrawl never has to consider', async () => {
      // A crawl killed mid-flight is exactly when a row is left claimed. A row
      // claiming to be in flight with nothing flying it is this bug's frontier
      // version, and finishCrawl only ever sees `queued`.
      const crawlId = await runningCrawl(STALE_MS);
      await frontierRow(crawlId, `${ORIGIN}/inflight`, 'fetching');

      await reapAbandonedCrawls(db, new Date());
      const [row] = await harness.owner
        .select()
        .from(crawlFrontier)
        .where(eq(crawlFrontier.crawlId, crawlId));
      expect(row?.state).toBe('skipped');
      expect(row?.skipReason).toBe('abandoned');
    });

    it('leaves already-fetched rows alone — that work really happened', async () => {
      const crawlId = await runningCrawl(STALE_MS);
      await frontierRow(crawlId, `${ORIGIN}/done`, 'fetched');

      await reapAbandonedCrawls(db, new Date());
      const [row] = await harness.owner
        .select()
        .from(crawlFrontier)
        .where(eq(crawlFrontier.crawlId, crawlId));
      expect(row?.state).toBe('fetched');
      expect(row?.skipReason).toBeNull();
    });

    it('does not touch the frontier of a crawl it did not reap', async () => {
      const live = await runningCrawl(1_000);
      await frontierRow(live, `${ORIGIN}/live`, 'queued');

      await reapAbandonedCrawls(db, new Date());
      const [row] = await harness.owner
        .select()
        .from(crawlFrontier)
        .where(eq(crawlFrontier.crawlId, live));
      expect(row?.state).toBe('queued');
    });
  });

  // -------------------------------------------------------------------------

  describe('across workspaces', () => {
    it('reaps stale crawls in every workspace, not just the first', async () => {
      const mine = await runningCrawl(STALE_MS);
      const theirs = await runningCrawl(STALE_MS, otherWorkspaceId, otherSiteId);

      const reaped = await reapAbandonedCrawls(db, new Date());
      expect(reaped.map((r) => r.crawlId).sort()).toEqual([mine, theirs].sort());
      expect(new Set(reaped.map((r) => r.workspaceId)).size).toBe(2);
    });

    it('reports the workspace each reaped crawl belonged to', async () => {
      const theirs = await runningCrawl(STALE_MS, otherWorkspaceId, otherSiteId);
      const [reaped] = await reapAbandonedCrawls(db, new Date());
      expect(reaped).toMatchObject({
        crawlId: theirs,
        workspaceId: otherWorkspaceId,
        siteId: otherSiteId,
      });
    });

    it('a workspace with no crawls costs nothing and reports nothing', async () => {
      expect(await reapAbandonedCrawls(db, new Date())).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('crawlStaleAfter', () => {
    it('is the start plus the page budget plus discovery slack', () => {
      const started = new Date('2026-08-20T00:00:00.000Z');
      // 10 pages × 30s = 300s, plus 30min slack.
      expect(crawlStaleAfter(started, 10).toISOString()).toBe('2026-08-20T00:35:00.000Z');
    });

    it('scales with page_limit, so a bigger crawl gets longer', () => {
      const started = new Date('2026-08-20T00:00:00.000Z');
      expect(crawlStaleAfter(started, 5000).getTime()).toBeGreaterThan(
        crawlStaleAfter(started, 10).getTime(),
      );
    });
  });
});
