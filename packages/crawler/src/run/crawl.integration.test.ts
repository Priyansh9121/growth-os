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

const { crawlFrontier, crawlPages, crawls, sitePages, sites, workspaces } = schemaTables;

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
