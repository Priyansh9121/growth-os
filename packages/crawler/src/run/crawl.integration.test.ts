/**
 * One crawl run, end to end, against a real database.
 *
 * ⚠️ THREE SUBSYSTEMS COMPOSED FOR THE FIRST TIME. Each is already tested in
 * isolation; what is untested until here is the ORDER — that robots gates the
 * rest, that a missing sitemap stops nothing, and that the loop ends with an
 * honest termination reason rather than by running out of patience.
 *
 * @see docs/decisions/ADR-0053-the-crawl-run.md
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
import { FixtureResolver, FixtureTransport } from '@growth-os/net/testing';
import type { SafeFetchDependencies } from '@growth-os/net';
import { runCrawl } from './crawl';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { crawlFrontier, crawlLinks, crawlPages, crawls, sitePages, sites, workspaces } =
  schemaTables;

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';

const html = (body: string) => ({
  status: 200,
  headers: { 'content-type': 'text/html' },
  body,
});

const xml = (body: string) => ({
  status: 200,
  headers: { 'content-type': 'application/xml' },
  body,
});

const sitemapOf = (...paths: string[]): string =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`)
    .join('')}</urlset>`;

function net(routes: Record<string, unknown>): SafeFetchDependencies {
  return {
    resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
    transport: new FixtureTransport(
      routes as Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
    ),
  };
}

describeIntegration('one crawl run', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let siteId: string;
  let crawlId: string;

  const deps = (network: SafeFetchDependencies) => ({
    network,
    inTenant: <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
      withTenantTransaction(harness.app as unknown as Database, workspaceId, fn as never),
    now: () => new Date(),
  });

  const input = (overrides: Partial<{ pageLimit: number; maxDepth: number }> = {}) => ({
    workspaceId,
    crawlId,
    siteId,
    origin: ORIGIN,
    pageLimit: 50,
    maxDepth: 5,
    ...overrides,
  });

  async function frontierRows() {
    return withTenantTransaction(harness.app as unknown as Database, workspaceId, (tx) =>
      tx
        .select({
          url: crawlFrontier.normalisedUrl,
          state: crawlFrontier.state,
          reason: crawlFrontier.skipReason,
        })
        .from(crawlFrontier)
        .where(eq(crawlFrontier.crawlId, crawlId)),
    );
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

  it('⚠️ runs a full crawl: robots, sitemap, pages, finished', async () => {
    const network = net({
      [`${ORIGIN}/robots.txt`]: { status: 200, body: 'User-agent: *\nAllow: /' },
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/contact', '/about')),
      [`${ORIGIN}/`]: html('<html>home</html>'),
      [`${ORIGIN}/contact`]: html('<html>contact</html>'),
      [`${ORIGIN}/about`]: html('<html>about</html>'),
    });

    const result = await runCrawl(deps(network), input());

    expect(result.robots).toBe('fetched');
    expect(result.sitemap).toBe('fetched');
    expect(result.pagesFetched).toBe(3);
    expect(result.pagesFailed).toBe(0);
    expect(result.termination).toBe('frontier_empty');
    expect(result.bytesDownloaded).toBeGreaterThan(0);

    // The crawl row records what the run learned.
    const [row] = await harness.owner.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(row?.status).toBe('completed');
    expect(row?.robotsOutcome).toBe('fetched');
    expect(row?.sitemapOutcome).toBe('fetched');
    expect(row?.pagesFetched).toBe(3);
    expect(row?.completedAt).not.toBeNull();

    // Every fetched page has a durable identity and an observation.
    expect(await harness.owner.select().from(sitePages)).toHaveLength(3);
    expect(await harness.owner.select().from(crawlPages)).toHaveLength(3);
  });

  it('⚠️ an unreadable robots.txt fetches ZERO pages, though a sitemap exists', async () => {
    // The fail-closed rule, end to end. The sitemap and its URLs are all
    // reachable — the only thing stopping the crawl is that permission could
    // not be read (ADR-0035).
    const network = net({
      [`${ORIGIN}/robots.txt`]: { status: 500 },
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/contact')),
      [`${ORIGIN}/`]: html('<html>home</html>'),
      [`${ORIGIN}/contact`]: html('<html>contact</html>'),
    });

    const result = await runCrawl(deps(network), input());

    expect(result.robots).toBe('unavailable');
    expect(result.pagesFetched).toBe(0);
    expect(await harness.owner.select().from(crawlPages)).toHaveLength(0);

    // ⚠️ And the sitemap was never even looked for.
    expect(result.sitemap).toBe('skipped');

    // The seed is recorded as discovered-and-refused, not silently absent.
    const rows = await frontierRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('skipped');
    expect(rows[0]?.reason).toBe('robots_disallowed');
  });

  it('⚠️ a missing sitemap does not stop the crawl — the seed is still fetched', async () => {
    const network = net({
      [`${ORIGIN}/robots.txt`]: { status: 404 },
      [`${ORIGIN}/sitemap.xml`]: { status: 404 },
      [`${ORIGIN}/`]: html('<html>home</html>'),
    });

    const result = await runCrawl(deps(network), input());

    expect(result.robots).toBe('absent');
    expect(result.sitemap).toBe('absent');
    expect(result.pagesFetched).toBe(1);
    expect(result.termination).toBe('frontier_empty');
  });

  // -------------------------------------------------------------------------
  // Discovery by link — the third source of candidates, after seed and sitemap
  // -------------------------------------------------------------------------

  describe('⚠️ links are the third source of frontier candidates', () => {
    it('⚠️ a sitemap-less crawl now discovers pages, where it used to return one', async () => {
      // THE behaviour this slice exists for. Identical fixture to "a missing
      // sitemap does not stop the crawl" above, except the seed states links.
      // That test asserts pagesFetched === 1 and still passes, because its
      // seed links to nothing — which is exactly the contrast worth keeping.
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html('<a href="/about">About</a><a href="/contact">Contact</a>'),
        [`${ORIGIN}/about`]: html('<a href="/team">The team</a>'),
        [`${ORIGIN}/contact`]: html('<html>contact</html>'),
        [`${ORIGIN}/team`]: html('<html>team</html>'),
      });

      const result = await runCrawl(deps(network), input());

      expect(result.sitemap).toBe('absent');
      // Seed → about, contact → team. Two link hops deep.
      expect(result.pagesFetched).toBe(4);
      expect(result.termination).toBe('frontier_empty');

      const urls = (await frontierRows()).map((r) => r.url).sort();
      expect(urls).toEqual([
        `${ORIGIN}/`,
        `${ORIGIN}/about`,
        `${ORIGIN}/contact`,
        `${ORIGIN}/team`,
      ]);
    });

    it('records every link as a fact, including the ones it will never fetch', async () => {
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html(
          '<a href="/about">About us</a>' +
            '<a href="https://supplier.test/parts" rel="nofollow">Our supplier</a>' +
            '<a href="https://blog.example.test/post">Our blog</a>',
        ),
        [`${ORIGIN}/about`]: html('<html>about</html>'),
      });

      await runCrawl(deps(network), input());

      const links = await harness.owner.select().from(crawlLinks);
      const byTarget = new Map(links.map((l) => [l.targetUrl, l]));

      expect(links).toHaveLength(3);
      expect(byTarget.get(`${ORIGIN}/about`)?.scope).toBe('internal');
      expect(byTarget.get(`${ORIGIN}/about`)?.anchorText).toBe('About us');
      expect(byTarget.get('https://supplier.test/parts')?.scope).toBe('external');
      expect(byTarget.get('https://supplier.test/parts')?.isNofollow).toBe(true);
      // A subdomain is NOT the same owner — blog.example.test could be anyone's
      // on wordpress.com. `classifyScope`'s verdict, not a second opinion.
      expect(byTarget.get('https://blog.example.test/post')?.scope).toBe('other_subdomain');

      // ⚠️ ...but only the internal one became work. The other two are
      // recorded and NOT in the frontier (ADR-0069).
      const urls = (await frontierRows()).map((r) => r.url).sort();
      expect(urls).toEqual([`${ORIGIN}/`, `${ORIGIN}/about`]);
    });

    it('⚠️ a nofollow internal link IS still crawled', async () => {
      // nofollow tells a search engine not to pass weight. It does not tell a
      // site's own auditor not to look, and a quietly de-emphasised internal
      // page is what an audit exists to surface (ADR-0069, decision 2).
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html('<a href="/legacy" rel="nofollow">Old prices</a>'),
        [`${ORIGIN}/legacy`]: html('<html>legacy</html>'),
      });

      const result = await runCrawl(deps(network), input());

      expect(result.pagesFetched).toBe(2);
      const [link] = await harness.owner.select().from(crawlLinks);
      expect(link?.isNofollow).toBe(true);
    });

    it('⚠️ discovered_from points at the frontier row that stated the link', async () => {
      // The column is a uuid self-reference to crawl_frontier.id, not a URL.
      // This is its first real value — the sitemap path leaves it null because
      // a sitemap document is not a frontier row.
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html('<a href="/about">About</a>'),
        [`${ORIGIN}/about`]: html('<html>about</html>'),
      });

      await runCrawl(deps(network), input());

      const rows = await harness.owner.select().from(crawlFrontier);
      const seed = rows.find((r) => r.normalisedUrl === `${ORIGIN}/`);
      const about = rows.find((r) => r.normalisedUrl === `${ORIGIN}/about`);

      expect(seed?.discoverySource).toBe('seed');
      expect(seed?.discoveredFrom).toBeNull();
      expect(about?.discoverySource).toBe('link');
      expect(about?.discoveredFrom).toBe(seed?.id);
      // A link hop is a depth hop.
      expect(seed?.depth).toBe(0);
      expect(about?.depth).toBe(1);
    });

    it('⚠️ maxDepth bounds link hops — the seed is depth 0, so 1 allows one hop', async () => {
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html('<a href="/one">One</a>'),
        [`${ORIGIN}/one`]: html('<a href="/two">Two</a>'),
        [`${ORIGIN}/two`]: html('<a href="/three">Three</a>'),
      });

      const result = await runCrawl(deps(network), input({ maxDepth: 1 }));

      expect(result.pagesFetched).toBe(2);
      const two = (await frontierRows()).find((r) => r.url === `${ORIGIN}/two`);
      expect(two?.state).toBe('skipped');
      expect(two?.reason).toBe('depth_limit');
    });

    it('a link cycle terminates — the frontier deduplicates, not the extractor', async () => {
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html('<a href="/a">A</a>'),
        [`${ORIGIN}/a`]: html('<a href="/">Home</a><a href="/a">Self</a><a href="/b">B</a>'),
        [`${ORIGIN}/b`]: html('<a href="/a">Back to A</a>'),
      });

      const result = await runCrawl(deps(network), input());

      expect(result.pagesFetched).toBe(3);
      expect(result.termination).toBe('frontier_empty');
      // Every edge recorded, including the self-link and the two back-edges.
      expect(await harness.owner.select().from(crawlLinks)).toHaveLength(5);
    });

    it('a robots-disallowed link is recorded as a link but never fetched', async () => {
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 200, body: 'User-agent: *\nDisallow: /admin' },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html('<a href="/admin">Admin</a><a href="/about">About</a>'),
        [`${ORIGIN}/about`]: html('<html>about</html>'),
      });

      const result = await runCrawl(deps(network), input());

      expect(result.pagesFetched).toBe(2);
      const admin = (await frontierRows()).find((r) => r.url === `${ORIGIN}/admin`);
      expect(admin?.state).toBe('skipped');
      expect(admin?.reason).toBe('robots_disallowed');
      // The link is still a fact about the document (§5).
      const targets = (await harness.owner.select().from(crawlLinks)).map((l) => l.targetUrl);
      expect(targets).toContain(`${ORIGIN}/admin`);
    });

    /**
     * ⚠️ THE REDELIVERY THAT NO OTHER TEST IN THIS FILE REACHES.
     *
     * Found by mutation testing: deleting the `crawlPageId === null` gate in
     * the page loop broke NOTHING, because every fixture here fetches each page
     * exactly once. The gate is ADR-0069's third decision and it was
     * unprotected.
     *
     * The queue is at-least-once, so the real shape is: the page transaction
     * commits, the worker dies before acknowledging, and the same frontier row
     * is claimed again while `crawl_pages` already holds its observation.
     * Resetting the row and re-running reproduces exactly that — no refactor,
     * the production path.
     */
    it('⚠️ a redelivered page does not write its links a second time', async () => {
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: html('<a href="/about">About</a><a href="/contact">Contact</a>'),
        [`${ORIGIN}/about`]: html('<html>about</html>'),
        [`${ORIGIN}/contact`]: html('<html>contact</html>'),
      });

      await runCrawl(deps(network), input());

      const first = await harness.owner.select().from(crawlLinks);
      expect(first).toHaveLength(2);
      const observations = await harness.owner.select().from(crawlPages);
      expect(observations).toHaveLength(3);

      // Put the seed back on the queue and reopen the crawl: the worker
      // crashed after committing, so this row is delivered again.
      await harness.owner
        .update(crawlFrontier)
        .set({ state: 'queued', claimedAt: null, fetchedAt: null })
        .where(eq(crawlFrontier.normalisedUrl, `${ORIGIN}/`));
      await harness.owner
        .update(crawls)
        .set({ status: 'running', completedAt: null })
        .where(eq(crawls.id, crawlId));

      const again = await runCrawl(deps(network), input());

      // It really was re-fetched — otherwise this test proves nothing.
      expect(again.pagesFetched).toBe(1);

      // ⚠️ ...and wrote no second copy of the seed's links, and no second
      // observation. Both are the ON CONFLICT DO NOTHING + RETURNING signal.
      expect(await harness.owner.select().from(crawlLinks)).toHaveLength(2);
      expect(await harness.owner.select().from(crawlPages)).toHaveLength(3);
    });

    it('a page that fails to fetch records no links', async () => {
      const network = net({
        [`${ORIGIN}/robots.txt`]: { status: 404 },
        [`${ORIGIN}/sitemap.xml`]: { status: 404 },
        [`${ORIGIN}/`]: {
          status: 500,
          headers: { 'content-type': 'text/html' },
          body: '<a href="/x">x</a>',
        },
      });

      const result = await runCrawl(deps(network), input());

      expect(result.pagesFailed).toBe(1);
      expect(await harness.owner.select().from(crawlLinks)).toHaveLength(0);
    });
  });

  it('follows the Sitemap: line robots.txt declares, not only /sitemap.xml', async () => {
    const network = net({
      [`${ORIGIN}/robots.txt`]: {
        status: 200,
        body: `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemaps/pages.xml`,
      },
      [`${ORIGIN}/sitemaps/pages.xml`]: xml(sitemapOf('/', '/pricing')),
      [`${ORIGIN}/`]: html('<html>home</html>'),
      [`${ORIGIN}/pricing`]: html('<html>pricing</html>'),
    });

    const result = await runCrawl(deps(network), input());

    expect(result.sitemap).toBe('fetched');
    expect(result.pagesFetched).toBe(2);
  });

  it('a robots-disallowed path in the sitemap is never fetched', async () => {
    const network = net({
      [`${ORIGIN}/robots.txt`]: { status: 200, body: 'User-agent: *\nDisallow: /admin' },
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/admin/secret')),
      [`${ORIGIN}/`]: html('<html>home</html>'),
      [`${ORIGIN}/admin/secret`]: html('<html>SECRET</html>'),
    });

    const result = await runCrawl(deps(network), input());

    expect(result.pagesFetched).toBe(1);
    const rows = await frontierRows();
    const blocked = rows.find((r) => r.url.includes('/admin/'));
    expect(blocked?.state).toBe('skipped');
    expect(blocked?.reason).toBe('robots_disallowed');
  });

  it('records a page that returned 404 as failed, without stopping the crawl', async () => {
    const network = net({
      [`${ORIGIN}/robots.txt`]: { status: 404 },
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/gone')),
      [`${ORIGIN}/`]: html('<html>home</html>'),
      [`${ORIGIN}/gone`]: { status: 404 },
    });

    const result = await runCrawl(deps(network), input());

    expect(result.pagesFetched).toBe(1);
    expect(result.pagesFailed).toBe(1);
    expect(result.termination).toBe('frontier_empty');

    const rows = await frontierRows();
    expect(rows.find((r) => r.url.endsWith('/gone'))?.state).toBe('failed');
  });

  it('⚠️ stops at the page budget and says so', async () => {
    const network = net({
      [`${ORIGIN}/robots.txt`]: { status: 404 },
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/a', '/b', '/c', '/d')),
      [`${ORIGIN}/`]: html('home'),
      [`${ORIGIN}/a`]: html('a'),
      [`${ORIGIN}/b`]: html('b'),
      [`${ORIGIN}/c`]: html('c'),
      [`${ORIGIN}/d`]: html('d'),
    });

    await harness.owner.update(crawls).set({ pageLimit: 2 }).where(eq(crawls.id, crawlId));

    const result = await runCrawl(deps(network), input({ pageLimit: 2 }));

    expect(result.pagesFetched).toBe(2);
    expect(result.termination).toBe('budget_exhausted');
  });

  it('⚠️ a cancelled crawl stops and is recorded as cancelled, not completed', async () => {
    const network = net({
      [`${ORIGIN}/robots.txt`]: { status: 404 },
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/a')),
      [`${ORIGIN}/`]: html('home'),
      [`${ORIGIN}/a`]: html('a'),
    });

    await harness.owner
      .update(crawls)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(crawls.id, crawlId));

    const result = await runCrawl(deps(network), input());

    expect(result.termination).toBe('cancelled');
    expect(result.pagesFetched).toBe(0);

    const [row] = await harness.owner.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(row?.status).toBe('cancelled');
  });
});
