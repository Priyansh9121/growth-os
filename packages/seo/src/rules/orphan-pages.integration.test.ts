/**
 * The orphan rule against a real database and a real link graph.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * The rule IS a query. Its correctness is the join, the self-link predicate,
 * the outcome filter and the `ON CONFLICT` target — none of which exist outside
 * PostgreSQL. A mock would assert that the code calls Drizzle, which is not the
 * thing anyone is worried about.
 *
 * Every assertion runs as the RESTRICTED, NON-OWNER role, so the tenant scoping
 * exercised here is the RLS policy and not a `WHERE` clause.
 *
 * @see docs/decisions/ADR-0072-the-orphan-page-rule.md
 * @see docs/decisions/ADR-0070-findings-belong-to-a-crawl.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  withTenantTransaction,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { findOrphanPages, recordOrphanPages } from './orphan-pages';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { crawlLinks, crawlPages, crawls, seoFindings, sitePages, sites, workspaces } = schemaTables;

const ORIGIN = 'https://abcplumbing.test';
const OTHER_ORIGIN = 'https://meridianlegal.test';

describeIntegration('orphan_page — the rule against a real link graph', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let siteId: string;
  let crawlId: string;
  /** `crawl_pages.id` and `site_pages.id` for each URL, keyed by path. */
  let observation: Record<string, string>;
  let durable: Record<string, string>;

  async function inTenant<T>(
    fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
    workspace = workspaceId,
  ): Promise<T> {
    return withTenantTransaction(harness.app as unknown as Database, workspace, fn);
  }

  /**
   * Give the crawl a set of retrieved pages.
   *
   * Written through the same two tables `markFetched` writes — a durable
   * `site_pages` row and a `crawl_pages` observation pointing at it — because
   * the rule joins across exactly that pair.
   */
  async function retrieve(
    paths: readonly string[],
    outcome: 'fetched' | 'unchanged' | 'http_4xx' | 'failed' = 'fetched',
  ): Promise<void> {
    for (const path of paths) {
      const url = `${ORIGIN}${path}`;
      const [page] = await harness.owner
        .insert(sitePages)
        .values({ workspaceId, siteId, normalisedUrl: url })
        .returning();
      const [row] = await harness.owner
        .insert(crawlPages)
        .values({
          workspaceId,
          crawlId,
          siteId,
          sitePageId: page!.id,
          normalisedUrl: url,
          depth: 0,
          outcome,
          // `crawl_pages_failure_matches_outcome` requires a category for a
          // failed fetch and there is no status for one — the fixture obeys the
          // same constraints production does, which is how it caught itself.
          ...(outcome === 'failed'
            ? { failureCategory: 'connect_failed' as const, httpStatus: null }
            : { httpStatus: outcome === 'http_4xx' ? 404 : 200 }),
        })
        .returning();
      durable[path] = page!.id;
      observation[path] = row!.id;
    }
  }

  /** State that `from` linked to `to`. */
  async function link(
    from: string,
    to: string,
    scope: 'internal' | 'external' | 'other_subdomain' = 'internal',
  ): Promise<void> {
    await harness.owner.insert(crawlLinks).values({
      workspaceId,
      crawlId,
      sourcePageId: observation[from]!,
      targetUrl: to.startsWith('http') ? to : `${ORIGIN}${to}`,
      scope,
      anchorText: 'a link',
    });
  }

  const audit = () => inTenant((tx) => recordOrphanPages(tx, workspaceId, crawlId));

  const storedFindings = () =>
    harness.owner.select().from(seoFindings).where(eq(seoFindings.crawlId, crawlId));

  beforeAll(async () => {
    harness = await createTestHarness();
    await assertRestrictedRole(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    observation = {};
    durable = {};

    const inserted = await harness.owner
      .insert(workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing' },
        { name: 'Meridian Legal', slug: 'meridian-legal' },
      ])
      .returning();
    workspaceId = inserted[0]!.id;
    otherWorkspaceId = inserted[1]!.id;

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

  describe('what counts as an inbound link', () => {
    it('finds the page nothing links to, and leaves the linked one alone', async () => {
      await retrieve(['/', '/about', '/hidden']);
      await link('/', '/about');

      const result = await audit();

      expect(result.pagesConsidered).toBe(3);
      const rows = await storedFindings();
      // '/' is orphaned too — nothing links to the home page in this fixture.
      expect(new Set(rows.map((row) => row.sitePageId))).toEqual(
        new Set([durable['/'], durable['/hidden']]),
      );
      expect(result.orphansFound).toBe(2);
    });

    it('⚠️ a self-link is not an inbound link', async () => {
      // NOT IN THE BRIEF, and the rule under-reports without it. Almost every
      // page links to itself — a logo, a breadcrumb, a nav item. A page whose
      // only internal inbound link comes from itself is still unreachable from
      // the rest of the site, which is the condition being detected.
      await retrieve(['/', '/hidden']);
      await link('/hidden', '/hidden');

      const result = await audit();

      expect(result.orphansFound).toBe(2);
      expect(new Set((await storedFindings()).map((row) => row.sitePageId))).toEqual(
        new Set([durable['/'], durable['/hidden']]),
      );
    });

    it('one inbound link from ANY other page is enough', async () => {
      await retrieve(['/', '/about', '/hidden']);
      await link('/hidden', '/hidden'); // does not save it
      await link('/about', '/hidden'); // this does

      expect((await audit()).orphansFound).toBe(2);
      expect(new Set((await storedFindings()).map((row) => row.sitePageId))).toEqual(
        new Set([durable['/'], durable['/about']]),
      );
    });

    it('⚠️ an external or subdomain link to the URL does not rescue it', async () => {
      // `scope` is the verdict of the crawler's one `classifyScope`, read from
      // the column rather than recomputed here. An orphan is a page the SITE
      // does not link to; a link that is not internal is not the site's.
      await retrieve(['/', '/hidden']);
      await link('/', `${ORIGIN}/hidden`, 'external');
      await link('/', `${ORIGIN}/hidden`, 'other_subdomain');

      expect((await audit()).orphansFound).toBe(2);
    });

    it('a link to a URL nothing retrieved produces no finding for it', async () => {
      // `crawl_links.target_url` is not a foreign key: a link may point at a
      // page that was never fetched, or does not exist. The rule reports on
      // pages, not on URLs somebody mentioned.
      await retrieve(['/']);
      await link('/', '/never-fetched');

      const result = await audit();

      expect(result.pagesConsidered).toBe(1);
      expect(result.orphansFound).toBe(1);
      expect((await storedFindings()).map((row) => row.sitePageId)).toEqual([durable['/']]);
    });
  });

  describe('the denominator is the pages RETRIEVED', () => {
    it('⚠️ a 404 is neither counted nor reported', async () => {
      // The brief said "out of N pages crawled". `crawl_pages` holds a row for
      // every attempt. A 404 has no content, states no links and cannot be
      // orphaned; counting it inflates the denominator and emits a finding for
      // every broken URL on the site.
      await retrieve(['/']);
      await retrieve(['/gone'], 'http_4xx');
      await retrieve(['/broke'], 'failed');

      const result = await audit();

      expect(result.pagesConsidered).toBe(1);
      expect((await storedFindings()).map((row) => row.sitePageId)).toEqual([durable['/']]);
    });

    it('⚠️ an observation with no durable page is dropped, not crashed on', async () => {
      // `crawl_pages.site_page_id` is NULLABLE and `seo_findings.site_page_id`
      // is NOT NULL (ADR-0070), so a row the rule cannot name is representable
      // even though `markFetched` — the only production writer — always sets
      // it. Without the `isNotNull` guard this row reaches the insert and the
      // whole audit dies with a 23502 because of one malformed observation.
      //
      // This test exists because deleting that guard was a mutation that
      // SURVIVED: every fixture went through `markFetched`'s shape, so the
      // branch was unreachable by construction.
      await retrieve(['/']);
      await harness.owner.insert(crawlPages).values({
        workspaceId,
        crawlId,
        siteId,
        sitePageId: null,
        normalisedUrl: `${ORIGIN}/unresolved`,
        depth: 0,
        outcome: 'fetched',
        httpStatus: 200,
      });

      const result = await audit();

      // Dropped from the population as well as from the findings — it is not a
      // page the rule was able to consider.
      expect(result).toEqual({ pagesConsidered: 1, orphansFound: 1, findingsWritten: 1 });
      expect((await storedFindings()).map((row) => row.sitePageId)).toEqual([durable['/']]);
    });

    it('a 304 IS a retrieved page — its facts were carried forward', async () => {
      await retrieve(['/'], 'unchanged');

      expect((await audit()).pagesConsidered).toBe(1);
    });

    it('the denominator is the population, not the orphan count', async () => {
      await retrieve(['/', '/a', '/b', '/hidden']);
      await link('/', '/a');
      await link('/', '/b');
      await link('/a', '/');

      const result = await audit();

      expect(result.pagesConsidered).toBe(4);
      expect(result.orphansFound).toBe(1);
      const [row] = await storedFindings();
      expect(row?.evidence).toEqual({ internalInboundLinks: 0, pagesConsidered: 4 });
      expect(row?.sitePageId).toBe(durable['/hidden']);
    });
  });

  describe('the audit is idempotent', () => {
    it('⚠️ a second audit of the same crawl finds the same orphans and writes nothing', async () => {
      // The unique index is the retry guarantee (ADR-0070), and `RETURNING` on a
      // `DO NOTHING` insert is what makes it observable (ADR-0067). A re-audit
      // must not double every finding on the crawl.
      await retrieve(['/', '/hidden']);
      await link('/', '/hidden');

      const first = await audit();
      const second = await audit();

      expect(first).toEqual({ pagesConsidered: 2, orphansFound: 1, findingsWritten: 1 });
      expect(second).toEqual({ pagesConsidered: 2, orphansFound: 1, findingsWritten: 0 });
      expect(await storedFindings()).toHaveLength(1);
    });

    it('a crawl with no orphans writes no rows', async () => {
      // The per-crawl lifetime means a closed finding is an ABSENT row, so
      // "nothing is orphaned" must write nothing rather than a row saying zero.
      await retrieve(['/', '/about']);
      await link('/', '/about');
      await link('/about', '/');

      expect(await audit()).toEqual({
        pagesConsidered: 2,
        orphansFound: 0,
        findingsWritten: 0,
      });
      expect(await storedFindings()).toHaveLength(0);
    });

    it('a crawl with no pages at all is not an error', async () => {
      expect(await audit()).toEqual({
        pagesConsidered: 0,
        orphansFound: 0,
        findingsWritten: 0,
      });
    });
  });

  describe('scoping', () => {
    it('⚠️ reads only the crawl it was given', async () => {
      // Two crawls of the same site. The older one's links must not make a page
      // look reachable in the newer one — that is the whole reason a finding
      // belongs to a crawl (ADR-0070).
      await retrieve(['/', '/hidden']);
      await link('/', '/hidden');

      const [second] = await harness.owner
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

      // The second crawl retrieves the same two pages and states NO links.
      for (const path of ['/', '/hidden']) {
        await harness.owner.insert(crawlPages).values({
          workspaceId,
          crawlId: second!.id,
          siteId,
          sitePageId: durable[path]!,
          normalisedUrl: `${ORIGIN}${path}`,
          depth: 0,
          outcome: 'fetched',
          httpStatus: 200,
        });
      }

      const result = await inTenant((tx) => recordOrphanPages(tx, workspaceId, second!.id));

      expect(result.orphansFound).toBe(2);
      // And the first crawl's own finding is untouched beside it.
      await audit();
      expect((await storedFindings()).map((row) => row.sitePageId)).toEqual([durable['/']]);
    });

    it('⚠️ another tenant sees none of it — the scoping is RLS, not a WHERE clause', async () => {
      await retrieve(['/', '/hidden']);
      await link('/', '/hidden');
      await audit();

      // Scoped to the OTHER workspace, the same crawl id reads as empty: the
      // policy filters both crawl_pages and crawl_links before the rule runs.
      const seen = await withTenantTransaction(
        harness.app as unknown as Database,
        otherWorkspaceId,
        (tx) => findOrphanPages(tx, crawlId),
      );

      expect(seen).toEqual({ pagesConsidered: 0, orphans: [] });
    });

    it('refuses to stamp a finding with a workspace the transaction is not scoped to', async () => {
      await retrieve(['/hidden']);

      // 42501 is `insufficient_privilege` — the INSERT policy's WITH CHECK.
      await expect(
        inTenant((tx) => recordOrphanPages(tx, otherWorkspaceId, crawlId)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });

      expect(await storedFindings()).toHaveLength(0);
    });
  });

  it('the finding points at the DURABLE page, not the observation', async () => {
    // ADR-0070's decision 2, proven rather than asserted: the id stored is a
    // `site_pages` id, and the `crawl_pages` id for the same URL is a different
    // value. This is what makes "still orphaned in March" a query.
    await retrieve(['/hidden']);

    await audit();

    const [row] = await storedFindings();
    expect(row?.sitePageId).toBe(durable['/hidden']);
    expect(row?.sitePageId).not.toBe(observation['/hidden']);

    const [page] = await harness.owner
      .select()
      .from(sitePages)
      .where(eq(sitePages.id, row!.sitePageId));
    expect(page?.normalisedUrl).toBe(`${ORIGIN}/hidden`);
  });

  it('a page retrieved by a crawl of another site is not in this crawl', async () => {
    // Guards the join: `crawl_pages` is filtered by `crawl_id`, so a second
    // site's pages in the same workspace cannot enter the population.
    await retrieve(['/']);

    const [otherSite] = await harness.owner
      .insert(sites)
      .values({
        workspaceId,
        name: 'Second',
        origin: OTHER_ORIGIN,
        verificationState: 'verified',
        verifiedAt: new Date(),
        verificationMethod: 'html_meta',
      })
      .returning();
    const [otherCrawl] = await harness.owner
      .insert(crawls)
      .values({
        workspaceId,
        siteId: otherSite!.id,
        origin: OTHER_ORIGIN,
        pageLimit: 50,
        maxDepth: 5,
        trigger: 'manual',
        status: 'running',
        startedAt: new Date(),
      })
      .returning();
    const [otherPage] = await harness.owner
      .insert(sitePages)
      .values({ workspaceId, siteId: otherSite!.id, normalisedUrl: `${OTHER_ORIGIN}/` })
      .returning();
    await harness.owner.insert(crawlPages).values({
      workspaceId,
      crawlId: otherCrawl!.id,
      siteId: otherSite!.id,
      sitePageId: otherPage!.id,
      normalisedUrl: `${OTHER_ORIGIN}/`,
      depth: 0,
      outcome: 'fetched',
      httpStatus: 200,
    });

    expect((await audit()).pagesConsidered).toBe(1);
  });
});
