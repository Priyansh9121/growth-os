/**
 * The frontier, against a real database.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * Three of the frontier's guarantees are the database's: deduplication is a
 * unique index, claiming is `FOR UPDATE SKIP LOCKED`, and the identity/observation
 * split is two constraints. A mock would assert that the code calls Drizzle,
 * which is not the property anyone cares about.
 *
 * Every assertion runs as the RESTRICTED, NON-OWNER role. A suite connected as
 * the migration role would pass while proving nothing about row-level security.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  withTenantTransaction,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import {
  claimNext,
  crawlProgress,
  enqueueDiscovered,
  finishCrawl,
  frontierCounts,
  markFetched,
  seedFrontier,
  type EnqueueEnvironment,
} from './frontier';
import { frontierRowCeiling, type Candidate } from './decide';
import { ALLOW_ALL, parseRobotsTxt } from '../robots/parse';
import { crawlScope } from '../urls/scope';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { crawlFrontier, crawlPages, crawls, sitePages, sites, workspaces } = schemaTables;

const ORIGIN = 'https://example.test';

describeIntegration('the crawl frontier', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let siteId: string;
  let crawlId: string;

  const environment = (overrides: Partial<EnqueueEnvironment> = {}): EnqueueEnvironment => ({
    scope: crawlScope(ORIGIN),
    robots: ALLOW_ALL,
    siteDisallowed: false,
    budget: { pageLimit: 50, maxDepth: 5, maxRows: frontierRowCeiling(50) },
    ...overrides,
  });

  /** Run against the RESTRICTED role, tenant-scoped, exactly as the worker will. */
  async function inTenant<T>(
    fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(harness.app as unknown as Database, workspaceId, fn);
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

    const [workspace] = await harness.owner
      .insert(workspaces)
      .values({ name: 'ABC Plumbing', slug: 'abc-plumbing' })
      .returning();
    workspaceId = workspace!.id;

    const [site] = await harness.owner
      .insert(sites)
      .values({
        workspaceId,
        name: 'Main',
        origin: ORIGIN,
        verificationState: 'verified',
        verifiedAt: new Date(),
        verificationMethod: 'html_meta',
      })
      .returning();
    siteId = site!.id;

    const [crawl] = await harness.owner
      .insert(crawls)
      .values({
        workspaceId,
        siteId,
        origin: ORIGIN,
        pageLimit: 50,
        maxDepth: 5,
        trigger: 'manual',
        status: 'running',
        startedAt: new Date(),
      })
      .returning();
    crawlId = crawl!.id;
  });

  // -------------------------------------------------------------------------
  // Seeding and deduplication
  // -------------------------------------------------------------------------

  describe('seeding', () => {
    it('seeds one queued row from the origin', async () => {
      const summary = await inTenant((tx) =>
        seedFrontier(tx, workspaceId, crawlId, environment(), ORIGIN),
      );

      expect(summary.queued).toBe(1);
      const rows = await harness.owner.select().from(crawlFrontier);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.normalisedUrl).toBe('https://example.test/');
      expect(rows[0]?.discoverySource).toBe('seed');
      expect(rows[0]?.depth).toBe(0);
    });

    it('⚠️ refuses the seed when robots disallows the root', async () => {
      // The seed goes through the same decision as every other URL. Inserting it
      // directly would fetch the one page the site most clearly refused.
      const summary = await inTenant((tx) =>
        seedFrontier(
          tx,
          workspaceId,
          crawlId,
          environment({ robots: parseRobotsTxt('User-agent: *\nDisallow: /') }),
          ORIGIN,
        ),
      );

      expect(summary.queued).toBe(0);
      expect(summary.skipped).toBe(1);
      const [row] = await harness.owner.select().from(crawlFrontier);
      expect(row?.state).toBe('skipped');
      expect(row?.skipReason).toBe('robots_disallowed');
    });

    it('refuses the seed when the site is fail-closed', async () => {
      const summary = await inTenant((tx) =>
        seedFrontier(tx, workspaceId, crawlId, environment({ siteDisallowed: true }), ORIGIN),
      );
      expect(summary.queued).toBe(0);
    });
  });

  describe('deduplication', () => {
    it('⚠️ never enqueues one page twice, whatever spelling it arrived in', async () => {
      const spellings: Candidate[] = [
        { url: 'https://example.test/about', depth: 1, source: 'link' },
        { url: 'https://EXAMPLE.test/about', depth: 1, source: 'link' },
        { url: 'https://example.test:443/about', depth: 1, source: 'link' },
        { url: 'https://example.test/about#team', depth: 1, source: 'link' },
        { url: 'https://example.test/about?utm_source=x', depth: 2, source: 'sitemap' },
        { url: '/about', base: 'https://example.test/', depth: 3, source: 'link' },
      ];

      const summary = await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), spellings),
      );

      expect(summary.queued).toBe(1);
      expect(await harness.owner.select().from(crawlFrontier)).toHaveLength(1);
    });

    it('does not re-enqueue across separate calls', async () => {
      const one: Candidate[] = [{ url: `${ORIGIN}/a`, depth: 1, source: 'link' }];
      await inTenant((tx) => enqueueDiscovered(tx, workspaceId, crawlId, environment(), one));
      const second = await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), one),
      );

      expect(second.queued).toBe(0);
      expect(second.duplicates).toBe(1);
      expect(await harness.owner.select().from(crawlFrontier)).toHaveLength(1);
    });

    it('⚠️ REGRESSION: a duplicate must not consume the page budget', async () => {
      // The first implementation decided every candidate and let the unique index
      // reject the duplicates — after the running budget counter had already been
      // incremented for them. Every page links back to the root and its siblings,
      // so a page with ten links of which eight were known spent eight units of a
      // budget it never used. A crawl configured for 4 pages fetched 1 and then
      // reported the frontier empty.
      const budgeted = environment({ budget: { pageLimit: 3, maxDepth: 5, maxRows: 500 } });

      await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, budgeted, [
          { url: `${ORIGIN}/a`, depth: 1, source: 'link' },
        ]),
      );

      // Now offer the SAME url nine more times, plus one genuinely new one.
      const summary = await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, budgeted, [
          ...Array.from({ length: 9 }, () => ({
            url: `${ORIGIN}/a`,
            depth: 1,
            source: 'link' as const,
          })),
          { url: `${ORIGIN}/b`, depth: 1, source: 'link' },
        ]),
      );

      expect(summary.duplicates).toBe(9);
      // The new URL is accepted: the nine duplicates cost nothing.
      expect(summary.queued).toBe(1);

      const counts = await inTenant((tx) => frontierCounts(tx, crawlId));
      expect(counts.fetchable).toBe(2);
      expect(counts.rows).toBe(2);
    });

    it('the DATABASE enforces it, not application code', async () => {
      // Two page workers discovering /contact in the same millisecond is the
      // normal case on a site where every page links to it.
      await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), [
          { url: `${ORIGIN}/contact`, depth: 1, source: 'link' },
        ]),
      );

      await expect(
        harness.owner
          .insert(crawlFrontier)
          .values({ workspaceId, crawlId, normalisedUrl: `${ORIGIN}/contact`, state: 'queued' }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Refusals are recorded
  // -------------------------------------------------------------------------

  describe('refusals are recorded with their reason', () => {
    it('keeps external and subdomain links as facts, not silent drops', async () => {
      const summary = await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), [
          { url: `${ORIGIN}/ok`, depth: 1, source: 'link' },
          { url: 'https://facebook.test/abc', depth: 1, source: 'link' },
          { url: 'https://blog.example.test/x', depth: 1, source: 'link' },
        ]),
      );

      expect(summary.queued).toBe(1);
      expect(summary.skipped).toBe(2);

      const reasons = await harness.owner
        .select({ url: crawlFrontier.normalisedUrl, reason: crawlFrontier.skipReason })
        .from(crawlFrontier)
        .where(eq(crawlFrontier.state, 'skipped'));

      expect(new Set(reasons.map((r) => r.reason))).toEqual(
        new Set(['external', 'other_subdomain']),
      );
    });

    it('records the deciding robots rule on the row', async () => {
      await inTenant((tx) =>
        enqueueDiscovered(
          tx,
          workspaceId,
          crawlId,
          environment({ robots: parseRobotsTxt('User-agent: *\nDisallow: /admin') }),
          [{ url: `${ORIGIN}/admin/users`, depth: 1, source: 'link' }],
        ),
      );

      const [row] = await harness.owner.select().from(crawlFrontier);
      expect(row?.state).toBe('skipped');
      expect(row?.skipReason).toBe('robots_disallowed');
    });

    it('⚠️ a skipped URL does not consume the page budget (ADR-0036)', async () => {
      // The reading that matters: a site with 400 external links must not get a
      // fraction of the crawl it configured.
      const externals: Candidate[] = Array.from({ length: 60 }, (_, i) => ({
        url: `https://other${i}.test/x`,
        depth: 1,
        source: 'link' as const,
      }));

      await inTenant((tx) => enqueueDiscovered(tx, workspaceId, crawlId, environment(), externals));

      const counts = await inTenant((tx) => frontierCounts(tx, crawlId));
      expect(counts.rows).toBe(60);
      expect(counts.fetchable).toBe(0);

      // 60 skipped rows written, and the full page budget still available.
      const summary = await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), [
          { url: `${ORIGIN}/still-room`, depth: 1, source: 'link' },
        ]),
      );
      expect(summary.queued).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Claiming, and attaching to the durable page
  // -------------------------------------------------------------------------

  describe('claim and complete', () => {
    it('claims shallowest first, and marks the row fetching', async () => {
      await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), [
          { url: `${ORIGIN}/deep/a`, depth: 3, source: 'link' },
          { url: `${ORIGIN}/shallow`, depth: 1, source: 'link' },
        ]),
      );

      const claimed = await inTenant((tx) => claimNext(tx, crawlId, 1, new Date()));
      expect(claimed[0]?.normalisedUrl).toBe(`${ORIGIN}/shallow`);

      const [row] = await harness.owner
        .select()
        .from(crawlFrontier)
        .where(eq(crawlFrontier.normalisedUrl, `${ORIGIN}/shallow`));
      expect(row?.state).toBe('fetching');
      expect(row?.claimedAt).not.toBeNull();
    });

    it('never claims the same URL twice under concurrency', async () => {
      const many: Candidate[] = Array.from({ length: 6 }, (_, i) => ({
        url: `${ORIGIN}/p${i}`,
        depth: 1,
        source: 'link' as const,
      }));
      await inTenant((tx) => enqueueDiscovered(tx, workspaceId, crawlId, environment(), many));

      const [a, b, c] = await Promise.all([
        inTenant((tx) => claimNext(tx, crawlId, 3, new Date())),
        inTenant((tx) => claimNext(tx, crawlId, 3, new Date())),
        inTenant((tx) => claimNext(tx, crawlId, 3, new Date())),
      ]);

      const urls = [...a, ...b, ...c].map((u) => u.normalisedUrl);
      expect(urls).toHaveLength(6);
      expect(new Set(urls).size).toBe(6);
    });

    it('⚠️ attaches the observation to a DURABLE page identity (horizon #1)', async () => {
      await inTenant((tx) => seedFrontier(tx, workspaceId, crawlId, environment(), ORIGIN));
      const [claimed] = await inTenant((tx) => claimNext(tx, crawlId, 1, new Date()));

      const { sitePageId } = await inTenant((tx) =>
        markFetched(tx, workspaceId, {
          crawlId,
          siteId,
          frontierId: claimed!.id,
          normalisedUrl: claimed!.normalisedUrl,
          depth: 0,
          now: new Date(),
          observation: { outcome: 'fetched', httpStatus: 200, title: 'Home' },
        }),
      );

      const [page] = await harness.owner.select().from(sitePages);
      expect(page?.id).toBe(sitePageId);
      expect(page?.normalisedUrl).toBe('https://example.test/');

      const [observation] = await harness.owner.select().from(crawlPages);
      expect(observation?.sitePageId).toBe(sitePageId);
      expect(observation?.title).toBe('Home');

      const [row] = await harness.owner.select().from(crawlFrontier);
      expect(row?.state).toBe('fetched');
    });

    it('⚠️ a second crawl reuses the identity and never rewrites first_seen_at', async () => {
      // The one fact site_pages exists to remember. Overwriting it would make
      // "how long has this page existed?" answer "since the last crawl".
      await inTenant((tx) => seedFrontier(tx, workspaceId, crawlId, environment(), ORIGIN));
      const [first] = await inTenant((tx) => claimNext(tx, crawlId, 1, new Date()));
      const firstSeen = new Date('2026-01-01T00:00:00Z');
      await inTenant((tx) =>
        markFetched(tx, workspaceId, {
          crawlId,
          siteId,
          frontierId: first!.id,
          normalisedUrl: first!.normalisedUrl,
          depth: 0,
          now: firstSeen,
          observation: { outcome: 'fetched', httpStatus: 200, title: 'Old title' },
        }),
      );

      const [second] = await harness.owner
        .insert(crawls)
        .values({
          workspaceId,
          siteId,
          origin: ORIGIN,
          pageLimit: 50,
          maxDepth: 5,
          trigger: 'recrawl',
          status: 'running',
          startedAt: new Date(),
        })
        .returning();

      await inTenant((tx) => seedFrontier(tx, workspaceId, second!.id, environment(), ORIGIN));
      const [again] = await inTenant((tx) => claimNext(tx, second!.id, 1, new Date()));
      const laterSeen = new Date('2026-06-01T00:00:00Z');
      await inTenant((tx) =>
        markFetched(tx, workspaceId, {
          crawlId: second!.id,
          siteId,
          frontierId: again!.id,
          normalisedUrl: again!.normalisedUrl,
          depth: 0,
          now: laterSeen,
          observation: { outcome: 'fetched', httpStatus: 200, title: 'New title' },
        }),
      );

      // ONE durable page, TWO observations, and the title change is visible.
      expect(await harness.owner.select().from(sitePages)).toHaveLength(1);
      const [page] = await harness.owner.select().from(sitePages);
      expect(page?.firstSeenAt.toISOString()).toBe(firstSeen.toISOString());
      expect(page?.lastSeenAt.toISOString()).toBe(laterSeen.toISOString());

      const titles = await harness.owner.select({ title: crawlPages.title }).from(crawlPages);
      expect(new Set(titles.map((t) => t.title))).toEqual(new Set(['Old title', 'New title']));
    });

    it('a retried page job writes one observation, not two', async () => {
      await inTenant((tx) => seedFrontier(tx, workspaceId, crawlId, environment(), ORIGIN));
      const [claimed] = await inTenant((tx) => claimNext(tx, crawlId, 1, new Date()));

      const write = () =>
        inTenant((tx) =>
          markFetched(tx, workspaceId, {
            crawlId,
            siteId,
            frontierId: claimed!.id,
            normalisedUrl: claimed!.normalisedUrl,
            depth: 0,
            now: new Date(),
            observation: { outcome: 'fetched', httpStatus: 200 },
          }),
        );

      await write();
      await write();

      expect(await harness.owner.select().from(crawlPages)).toHaveLength(1);
      expect(await harness.owner.select().from(sitePages)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Termination — all four, each proved separately
  // -------------------------------------------------------------------------

  describe('termination', () => {
    it('1. frontier_empty — everything discovered has been fetched', async () => {
      await inTenant((tx) => seedFrontier(tx, workspaceId, crawlId, environment(), ORIGIN));
      const [claimed] = await inTenant((tx) => claimNext(tx, crawlId, 1, new Date()));
      await inTenant((tx) =>
        markFetched(tx, workspaceId, {
          crawlId,
          siteId,
          frontierId: claimed!.id,
          normalisedUrl: claimed!.normalisedUrl,
          depth: 0,
          now: new Date(),
          observation: { outcome: 'fetched', httpStatus: 200 },
        }),
      );

      const progress = await inTenant((tx) => crawlProgress(tx, crawlId, false));
      expect(progress.reason).toBe('frontier_empty');
    });

    it('2. budget_exhausted — the page limit is reached', async () => {
      const [small] = await harness.owner
        .insert(crawls)
        .values({
          workspaceId,
          siteId,
          origin: ORIGIN,
          pageLimit: 2,
          maxDepth: 5,
          trigger: 'manual',
          status: 'running',
          startedAt: new Date(),
        })
        .returning();

      const budgeted = environment({ budget: { pageLimit: 2, maxDepth: 5, maxRows: 500 } });
      const summary = await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, small!.id, budgeted, [
          { url: `${ORIGIN}/a`, depth: 1, source: 'link' },
          { url: `${ORIGIN}/b`, depth: 1, source: 'link' },
          { url: `${ORIGIN}/c`, depth: 1, source: 'link' },
        ]),
      );

      // Two queued; the third refused for budget and RECORDED.
      expect(summary.queued).toBe(2);
      expect(summary.skipped).toBe(1);

      const progress = await inTenant((tx) => crawlProgress(tx, small!.id, false));
      expect(progress.reason).toBe('budget_exhausted');
    });

    it('3. depth_exhausted — distinguishable from simply running out', async () => {
      const shallow = environment({ budget: { pageLimit: 50, maxDepth: 1, maxRows: 500 } });
      const summary = await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, shallow, [
          { url: `${ORIGIN}/too/deep`, depth: 2, source: 'link' },
        ]),
      );

      expect(summary.skippedForDepth).toBe(true);

      const progress = await inTenant((tx) => crawlProgress(tx, crawlId, summary.skippedForDepth));
      expect(progress.reason).toBe('depth_exhausted');

      // The same empty frontier, without a depth skip, reports differently.
      const other = await inTenant((tx) => crawlProgress(tx, crawlId, false));
      expect(other.reason).toBe('frontier_empty');
    });

    it('4. cancelled — and it wins over every other reason', async () => {
      await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), [
          { url: `${ORIGIN}/a`, depth: 1, source: 'link' },
        ]),
      );

      await harness.owner
        .update(crawls)
        .set({ cancelRequestedAt: new Date() })
        .where(eq(crawls.id, crawlId));

      const progress = await inTenant((tx) => crawlProgress(tx, crawlId, true));
      expect(progress.reason).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation leaves a coherent state
  // -------------------------------------------------------------------------

  describe('cancellation mid-crawl', () => {
    it('⚠️ keeps fetched pages, stops queued work, and says it was CANCELLED', async () => {
      await inTenant((tx) =>
        enqueueDiscovered(tx, workspaceId, crawlId, environment(), [
          { url: `${ORIGIN}/done`, depth: 1, source: 'link' },
          { url: `${ORIGIN}/pending-a`, depth: 1, source: 'link' },
          { url: `${ORIGIN}/pending-b`, depth: 1, source: 'link' },
        ]),
      );

      const claimed = await inTenant((tx) => claimNext(tx, crawlId, 1, new Date()));
      await inTenant((tx) =>
        markFetched(tx, workspaceId, {
          crawlId,
          siteId,
          frontierId: claimed[0]!.id,
          normalisedUrl: claimed[0]!.normalisedUrl,
          depth: 1,
          now: new Date(),
          observation: { outcome: 'fetched', httpStatus: 200, title: 'Kept' },
        }),
      );

      await inTenant((tx) => finishCrawl(tx, crawlId, 'cancelled', new Date()));

      const [crawl] = await harness.owner.select().from(crawls).where(eq(crawls.id, crawlId));
      // A cancelled crawl is `cancelled`, never `completed`. Reporting completion
      // would claim coverage it does not have.
      expect(crawl?.status).toBe('cancelled');
      expect(crawl?.completedAt).not.toBeNull();

      // The finished page survives — cancellation stops future work, it does not
      // invalidate work that completed.
      const observations = await harness.owner.select().from(crawlPages);
      expect(observations).toHaveLength(1);
      expect(observations[0]?.title).toBe('Kept');
      expect(await harness.owner.select().from(sitePages)).toHaveLength(1);

      // No half-written rows: nothing is left queued or fetching.
      const states = await harness.owner
        .select({ state: crawlFrontier.state, reason: crawlFrontier.skipReason })
        .from(crawlFrontier);
      expect(states.filter((s) => s.state === 'queued')).toHaveLength(0);
      expect(states.filter((s) => s.state === 'fetching')).toHaveLength(0);
      // The pending URLs are recorded as discovered-then-cancelled, not deleted:
      // erasing them would shrink the discovered total retroactively.
      expect(states.filter((s) => s.reason === 'cancelled')).toHaveLength(2);
      expect(crawl?.pagesDiscovered).toBe(3);
    });

    it('a normal finish reports completed', async () => {
      await inTenant((tx) => seedFrontier(tx, workspaceId, crawlId, environment(), ORIGIN));
      await inTenant((tx) => finishCrawl(tx, crawlId, 'frontier_empty', new Date()));

      const [crawl] = await harness.owner.select().from(crawls).where(eq(crawls.id, crawlId));
      expect(crawl?.status).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // The synthetic graph
  // -------------------------------------------------------------------------

  describe('a synthetic graph with cycles, self-links and duplicate spellings', () => {
    /**
     * Twelve pages. Every page links back to the root and to its neighbour, one
     * links to itself, several arrive under alternative spellings, and there are
     * two cycles. A crawler that mishandles any of it either loops forever or
     * reports the wrong page count.
     */
    const GRAPH: Record<string, string[]> = {
      '/': ['/a', '/b', '/', '/index.html'],
      '/a': ['/', '/b', '/a/1', '/A'],
      '/b': ['/', '/a', '/b/1', '/b?utm_source=x'],
      '/a/1': ['/a', '/a/2', '/'],
      '/a/2': ['/a/1', '/', '/a/2#top'],
      '/b/1': ['/b', '/b/2'],
      '/b/2': ['/b/1', '/b', '/'],
      '/index.html': ['/'],
      '/A': ['/'],
    };

    it('terminates, and visits each page exactly once', async () => {
      await inTenant((tx) => seedFrontier(tx, workspaceId, crawlId, environment(), ORIGIN));

      const fetched: string[] = [];
      let guard = 0;

      for (;;) {
        guard += 1;
        // The guard is the test's own safety net, not the crawler's. If the
        // frontier ever needs it, the loop did not terminate on its own and the
        // assertion below fails loudly rather than hanging CI.
        if (guard > 200) break;

        const progress = await inTenant((tx) => crawlProgress(tx, crawlId, false));
        if (progress.reason !== null) break;

        const claimed = await inTenant((tx) => claimNext(tx, crawlId, 3, new Date()));
        if (claimed.length === 0) break;

        for (const url of claimed) {
          const path = new URL(url.normalisedUrl).pathname;
          fetched.push(url.normalisedUrl);

          await inTenant(async (tx) => {
            await markFetched(tx, workspaceId, {
              crawlId,
              siteId,
              frontierId: url.id,
              normalisedUrl: url.normalisedUrl,
              depth: url.depth,
              now: new Date(),
              observation: { outcome: 'fetched', httpStatus: 200 },
            });

            const links = GRAPH[path] ?? ['/'];
            await enqueueDiscovered(
              tx,
              workspaceId,
              crawlId,
              environment(),
              links.map((href) => ({
                url: href,
                base: url.normalisedUrl,
                depth: url.depth + 1,
                source: 'link' as const,
              })),
              url.id,
            );
          });
        }
      }

      // TERMINATED on its own.
      expect(guard).toBeLessThanOrEqual(200);

      // EXACTLY ONCE each. The cycles, the self-link and the four spellings of
      // the root did not produce a single duplicate fetch.
      expect(new Set(fetched).size).toBe(fetched.length);

      const observations = await harness.owner.select().from(crawlPages);
      expect(observations).toHaveLength(fetched.length);

      // One durable identity per page, and the frontier agrees.
      const pages = await harness.owner.select().from(sitePages);
      expect(pages).toHaveLength(fetched.length);

      // `/index.html` and `/A` are DIFFERENT pages from `/` — paths are
      // case-sensitive and index.html is not the root. Nine distinct nodes.
      expect(fetched.length).toBe(9);

      const [remaining] = await harness.owner
        .select({ n: sql<number>`count(*)::int` })
        .from(crawlFrontier)
        .where(and(eq(crawlFrontier.crawlId, crawlId), eq(crawlFrontier.state, 'queued')));
      expect(remaining?.n).toBe(0);
    });

    it('stops at the page limit rather than exhausting the graph', async () => {
      const [limited] = await harness.owner
        .insert(crawls)
        .values({
          workspaceId,
          siteId,
          origin: ORIGIN,
          pageLimit: 4,
          maxDepth: 5,
          trigger: 'manual',
          status: 'running',
          startedAt: new Date(),
        })
        .returning();

      const budgeted = environment({ budget: { pageLimit: 4, maxDepth: 5, maxRows: 500 } });
      await inTenant((tx) => seedFrontier(tx, workspaceId, limited!.id, budgeted, ORIGIN));

      let guard = 0;
      const fetched: string[] = [];
      for (;;) {
        if ((guard += 1) > 100) break;
        const progress = await inTenant((tx) => crawlProgress(tx, limited!.id, false));
        if (progress.reason !== null) break;
        const claimed = await inTenant((tx) => claimNext(tx, limited!.id, 2, new Date()));
        if (claimed.length === 0) break;

        for (const url of claimed) {
          fetched.push(url.normalisedUrl);
          await inTenant(async (tx) => {
            await markFetched(tx, workspaceId, {
              crawlId: limited!.id,
              siteId,
              frontierId: url.id,
              normalisedUrl: url.normalisedUrl,
              depth: url.depth,
              now: new Date(),
              observation: { outcome: 'fetched', httpStatus: 200 },
            });
            const links = GRAPH[new URL(url.normalisedUrl).pathname] ?? ['/'];
            await enqueueDiscovered(
              tx,
              workspaceId,
              limited!.id,
              budgeted,
              links.map((href) => ({
                url: href,
                base: url.normalisedUrl,
                depth: url.depth + 1,
                source: 'link' as const,
              })),
              url.id,
            );
          });
        }
      }

      expect(fetched.length).toBeLessThanOrEqual(4);
      const progress = await inTenant((tx) => crawlProgress(tx, limited!.id, false));
      expect(progress.reason).toBe('budget_exhausted');
    });
  });
});
