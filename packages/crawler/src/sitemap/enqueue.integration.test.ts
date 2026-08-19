/**
 * Sitemap discovery reaching the frontier, against a real database.
 *
 * ⚠️ THE PROPERTY THIS SUITE EXISTS FOR: THERE IS NO SITEMAP ADMISSION PATH.
 *
 * A sitemap-listed URL is refused by scope, by robots, by depth and by the
 * budget in exactly the same way an `href` found on a page is. The cases below
 * are chosen to be ones a *parallel* implementation would plausibly get wrong —
 * an out-of-scope URL, a robots-disallowed URL, a whole site disallowed — and
 * each asserts the `skip_reason` the shared `decideEnqueue` writes.
 *
 * A unit test cannot prove this: the rows, the deduplication index and the
 * `discovery_source` column are the database's.
 *
 * @see docs/decisions/ADR-0052-sitemap-walk-bounds.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
import { enqueueFromSitemap } from './enqueue';
import { frontierRowCeiling } from '../frontier/decide';
import { type EnqueueEnvironment } from '../frontier/frontier';
import { ALLOW_ALL, parseRobotsTxt } from '../robots/parse';
import { crawlScope } from '../urls/scope';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { crawlFrontier, crawls, sites, workspaces } = schemaTables;

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';
const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;

const urlset = (...locs: string[]): string =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`;

function network(documents: Record<string, string>): SafeFetchDependencies {
  const routes: Record<string, { status: number; headers: Record<string, string>; body: string }> =
    {};
  for (const [url, body] of Object.entries(documents)) {
    routes[url] = { status: 200, headers: { 'content-type': 'application/xml' }, body };
  }
  return {
    resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP], 'other.test': [PUBLIC_IP] }),
    transport: new FixtureTransport(routes),
  };
}

describeIntegration('sitemap discovery reaches the frontier', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let crawlId: string;

  const environment = (overrides: Partial<EnqueueEnvironment> = {}): EnqueueEnvironment => ({
    scope: crawlScope(ORIGIN),
    robots: ALLOW_ALL,
    siteDisallowed: false,
    budget: { pageLimit: 50, maxDepth: 5, maxRows: frontierRowCeiling(50) },
    ...overrides,
  });

  async function inTenant<T>(
    fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(harness.app as unknown as Database, workspaceId, fn);
  }

  async function rows(): Promise<
    { url: string; state: string; skipReason: string | null; source: string | null }[]
  > {
    return inTenant(async (tx) => {
      const found = await tx
        .select({
          url: crawlFrontier.normalisedUrl,
          state: crawlFrontier.state,
          skipReason: crawlFrontier.skipReason,
          source: crawlFrontier.discoverySource,
        })
        .from(crawlFrontier)
        .where(and(eq(crawlFrontier.crawlId, crawlId)));
      return found;
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

    const [crawl] = await harness.owner
      .insert(crawls)
      .values({
        workspaceId,
        siteId: site!.id,
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

  it('queues the pages a sitemap listed, recorded as sitemap-discovered', async () => {
    const net = network({ [SITEMAP_URL]: urlset(`${ORIGIN}/`, `${ORIGIN}/contact`) });

    const result = await inTenant((tx) =>
      enqueueFromSitemap(tx, workspaceId, crawlId, environment(), net, SITEMAP_URL),
    );

    expect(result.summary.queued).toBe(2);

    const written = await rows();
    expect(written).toHaveLength(2);
    for (const row of written) {
      expect(row.state).toBe('queued');
      expect(row.source).toBe('sitemap');
    }
  });

  it('⚠️ an out-of-scope URL is refused by the SAME scope check, with the same reason', async () => {
    // A parallel admission path would plausibly trust a sitemap's own claims —
    // "the site listed it, so it is the site's". It is not: a sitemap can list
    // anything, and `classifyScope` is what decides.
    const net = network({
      [SITEMAP_URL]: urlset(`${ORIGIN}/a`, 'https://other.test/b'),
    });

    await inTenant((tx) =>
      enqueueFromSitemap(tx, workspaceId, crawlId, environment(), net, SITEMAP_URL),
    );

    const written = await rows();
    const external = written.find((r) => r.url.includes('other.test'));
    expect(external?.state).toBe('skipped');
    expect(external?.skipReason).toBe('external');
    expect(external?.source).toBe('sitemap');
  });

  it('⚠️ a robots-disallowed URL is refused, though the site listed it itself', async () => {
    // The interesting conflict: a site's sitemap advertising a path its own
    // robots.txt forbids. robots wins, because the sitemap is a suggestion and
    // robots is the permission artefact (ADR-0035).
    const net = network({ [SITEMAP_URL]: urlset(`${ORIGIN}/ok`, `${ORIGIN}/admin/secret`) });

    await inTenant((tx) =>
      enqueueFromSitemap(
        tx,
        workspaceId,
        crawlId,
        environment({ robots: parseRobotsTxt('User-agent: *\nDisallow: /admin') }),
        net,
        SITEMAP_URL,
      ),
    );

    const written = await rows();
    const blocked = written.find((r) => r.url.includes('/admin/'));
    expect(blocked?.state).toBe('skipped');
    expect(blocked?.skipReason).toBe('robots_disallowed');

    const allowed = written.find((r) => r.url.endsWith('/ok'));
    expect(allowed?.state).toBe('queued');
  });

  it('⚠️ a site disallowed because robots could not be read queues nothing', async () => {
    // Fail-closed carries through: the sitemap read fine, and none of it may be
    // crawled, because permission is robots' to grant and it could not be read.
    const net = network({ [SITEMAP_URL]: urlset(`${ORIGIN}/a`, `${ORIGIN}/b`) });

    const result = await inTenant((tx) =>
      enqueueFromSitemap(
        tx,
        workspaceId,
        crawlId,
        environment({ siteDisallowed: true }),
        net,
        SITEMAP_URL,
      ),
    );

    expect(result.summary.queued).toBe(0);
    const written = await rows();
    expect(written.every((r) => r.skipReason === 'robots_disallowed')).toBe(true);
  });

  it('⚠️ the page budget bounds sitemap discovery like any other', async () => {
    const locs = Array.from({ length: 10 }, (_, i) => `${ORIGIN}/p${i}`);
    const net = network({ [SITEMAP_URL]: urlset(...locs) });

    const result = await inTenant((tx) =>
      enqueueFromSitemap(
        tx,
        workspaceId,
        crawlId,
        environment({ budget: { pageLimit: 3, maxDepth: 5, maxRows: frontierRowCeiling(3) } }),
        net,
        SITEMAP_URL,
      ),
    );

    expect(result.summary.queued).toBe(3);
    const written = await rows();
    expect(written.filter((r) => r.skipReason === 'page_limit')).toHaveLength(7);
  });

  it('a URL already in the frontier is not queued twice', async () => {
    const net = network({ [SITEMAP_URL]: urlset(`${ORIGIN}/a`) });

    await inTenant((tx) =>
      enqueueFromSitemap(tx, workspaceId, crawlId, environment(), net, SITEMAP_URL),
    );
    const second = await inTenant((tx) =>
      enqueueFromSitemap(tx, workspaceId, crawlId, environment(), net, SITEMAP_URL),
    );

    expect(second.summary.queued).toBe(0);
    expect(second.summary.duplicates).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it('returns the walk facts alongside what the frontier did', async () => {
    const net = network({
      [SITEMAP_URL]: `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${ORIGIN}/s1.xml</loc></sitemap></sitemapindex>`,
      [`${ORIGIN}/s1.xml`]: urlset(`${ORIGIN}/a`),
    });

    const result = await inTenant((tx) =>
      enqueueFromSitemap(tx, workspaceId, crawlId, environment(), net, SITEMAP_URL),
    );

    expect(result.walk.visited).toHaveLength(2);
    expect(result.walk.stopped).toEqual([]);
    expect(result.summary.queued).toBe(1);
  });
});
