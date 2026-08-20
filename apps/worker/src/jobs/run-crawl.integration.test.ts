/**
 * The full loop: a person asks for a crawl, the worker runs it, the operator
 * reads what it found.
 *
 * ⚠️ THIS IS THE TEST THE PROJECT DID NOT HAVE. Every crawler subsystem was
 * tested in isolation and dev log 0035 measured that nothing composed them into
 * a path a person could reach. What is untested until here is the seam: that
 * `requestCrawl` produces a job the worker can actually claim, that the handler
 * drives the crawl to completion, and that the crawl row afterwards reflects
 * what really happened.
 *
 * ⚠️ IT NEVER REACHES THE NETWORK. Every fetch goes through a
 * `FixtureTransport`; the resolver is a fixture too. A real `productionNetwork`
 * would make this test depend on someone else's server (§6).
 *
 * @see docs/decisions/ADR-0054-starting-a-crawl.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { FixtureResolver, FixtureTransport } from '@growth-os/net/testing';
import type { SafeFetchDependencies } from '@growth-os/net';
import {
  createSite,
  getCrawl,
  reapAbandonedCrawls,
  requestCrawl,
  RUN_CRAWL_JOB,
  type SitesContext,
} from '@growth-os/sites';
import type { CrmDomainEvent, TenantActor, WorkspaceRole } from '@growth-os/contracts';
import { runCrawlJob } from './run-crawl';
import { claimJobs, completeJob, failJob } from '../queue';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;
const { crawlFrontier, crawlPages, crawls, jobs, sites, users, workspaces } = schemaTables;

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';

const html = (body: string) => ({ status: 200, headers: { 'content-type': 'text/html' }, body });
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

/** A site that allows everything and lists three pages. */
const OPEN_SITE = {
  [`${ORIGIN}/robots.txt`]: {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
  },
  [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/about', '/contact')),
  [`${ORIGIN}/`]: html('<html><head><title>Home</title></head></html>'),
  [`${ORIGIN}/about`]: html('<html><head><title>About</title></head></html>'),
  [`${ORIGIN}/contact`]: html('<html><head><title>Contact</title></head></html>'),
};

describeIntegration('start a crawl, run it, read the result', () => {
  let harness: TestHarness;
  let db: Database;
  let workspaceId: string;
  let userId: string;
  let published: CrmDomainEvent[];

  function contextFor(role: WorkspaceRole): SitesContext {
    const workspace = {
      workspaceId,
      workspaceName: 'Example',
      workspaceSlug: 'example',
      agencyId: null,
      role,
      via: 'direct' as const,
    };
    const tenant: TenantActor = {
      actor: {
        userId,
        email: 'sam@example.test',
        name: 'Sam',
        sessionId: 's',
        workspaces: [workspace],
        agencies: [],
      },
      workspace,
    };
    return {
      deps: { db, events: { publish: (event) => published.push(event) } },
      tenant,
      correlationId: null,
    };
  }

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
    published = [];
    const [workspace] = await harness.owner
      .insert(workspaces)
      .values({ name: 'Example', slug: 'example' })
      .returning();
    workspaceId = workspace!.id;
    const [user] = await harness.owner
      .insert(users)
      .values({ email: 'sam@example.test', name: 'Sam', passwordHash: null })
      .returning();
    userId = user!.id;
  });

  /** A verified site, which is the only kind that can be crawled. */
  async function verifiedSite(): Promise<string> {
    const site = await createSite(contextFor('owner'), { name: 'Main', origin: ORIGIN });
    await harness.owner
      .update(sites)
      .set({
        verificationState: 'verified',
        verifiedAt: new Date(),
        verificationMethod: 'html_meta',
      })
      .where(eq(sites.id, site.id));
    return site.id;
  }

  // -------------------------------------------------------------------------

  it('⚠️ THE FULL LOOP: request → queued job → worker runs it → status reflects it', async () => {
    const siteId = await verifiedSite();

    // 1. A member asks for a crawl.
    const { crawlId } = await requestCrawl(contextFor('member'), { siteId });
    expect((await getCrawl(contextFor('viewer'), crawlId)).status).toBe('queued');

    // 2. The worker claims the job through its REAL queue, not a stub — this
    //    is the seam that had never been exercised.
    const [job] = await claimJobs(db, 5, new Date());
    expect(job?.name).toBe(RUN_CRAWL_JOB);

    // 3. The handler drives it to completion.
    await runCrawlJob({ db, payload: job!.payload!, now: new Date() }, { network: net(OPEN_SITE) });
    await completeJob(db, job!.id, new Date());

    // 4. An operator reads the outcome, and it is the real one.
    const view = await getCrawl(contextFor('viewer'), crawlId);
    expect(view.status).toBe('completed');
    // `fetched` = 2xx and parsed. Allow/disallow is a PER-URL decision, not a
    // crawl-level outcome — this column records what happened when we asked.
    expect(view.robotsOutcome).toBe('fetched');
    expect(view.sitemapOutcome).toBe('fetched');
    expect(view.sitemapUrlCount).toBe(3);
    expect(view.pagesFetched).toBe(3);
    expect(view.pagesFailed).toBe(0);
    expect(view.bytesDownloaded).toBeGreaterThan(0);
    expect(view.startedAt).not.toBeNull();
    expect(view.completedAt).not.toBeNull();

    // And the facts it acquired are really there.
    const fetched = await harness.owner
      .select()
      .from(crawlPages)
      .where(eq(crawlPages.crawlId, crawlId));
    expect(fetched).toHaveLength(3);
  });

  it('a site with no sitemap yields a one-page crawl, and says so honestly', async () => {
    // The known limitation, asserted rather than described: there is no HTML
    // link extraction, so the seed is the only source of frontier candidates.
    const siteId = await verifiedSite();
    const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
    const [job] = await claimJobs(db, 5, new Date());

    await runCrawlJob(
      { db, payload: job!.payload!, now: new Date() },
      {
        network: net({
          [`${ORIGIN}/robots.txt`]: { status: 404, headers: {}, body: '' },
          [`${ORIGIN}/sitemap.xml`]: { status: 404, headers: {}, body: '' },
          [`${ORIGIN}/`]: html('<html><head><title>Home</title></head></html>'),
        }),
      },
    );

    const view = await getCrawl(contextFor('owner'), crawlId);
    expect(view.status).toBe('completed');
    expect(view.sitemapOutcome).toBe('absent');
    expect(view.pagesFetched).toBe(1);
  });

  it('a robots.txt that disallows everything fetches no pages', async () => {
    const siteId = await verifiedSite();
    const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
    const [job] = await claimJobs(db, 5, new Date());

    await runCrawlJob(
      { db, payload: job!.payload!, now: new Date() },
      {
        network: net({
          [`${ORIGIN}/robots.txt`]: {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: 'User-agent: *\nDisallow: /\n',
          },
        }),
      },
    );

    const view = await getCrawl(contextFor('owner'), crawlId);
    // Still `fetched` — we DID read the file. That it forbade everything shows
    // up as zero pages, not as a different robots outcome.
    expect(view.robotsOutcome).toBe('fetched');
    expect(view.pagesFetched).toBe(0);
  });

  // -------------------------------------------------------------------------
  // ⚠️ The failure path
  // -------------------------------------------------------------------------

  describe('⚠️ a transport fault during a PAGE fetch is not a crawl failure', () => {
    /** Serves robots.txt and a sitemap, then dies on every page request. */
    function explodingAfterDiscovery(): SafeFetchDependencies {
      const fixture = new FixtureTransport({
        [`${ORIGIN}/robots.txt`]: {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
        },
        [`${ORIGIN}/sitemap.xml`]: xml(sitemapOf('/', '/about')),
      });
      return {
        resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
        transport: {
          async send(...args: Parameters<FixtureTransport['send']>) {
            // `args[0]` is a TransportRequest, not a URL. Stringifying it gave
            // "[object Object]", so the first version of this threw on
            // robots.txt too — the site came back disallowed and the frontier
            // was empty, which is a completely different test.
            const url = args[0].url.toString();
            if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml')) {
              return fixture.send(...args);
            }
            throw new Error('connection reset');
          },
        },
      };
    }

    it('records pagesFailed and still COMPLETES — measured, not assumed', async () => {
      // ⚠️ This test was written expecting the job to throw. It does not, and
      // the behaviour it found is the correct one: a page that could not be
      // fetched is a FACT about that page, not a failure of the crawl. An
      // operator gets "2 of 2 pages failed, crawl completed", which is true and
      // actionable, rather than a crawl that vanished into a retry loop.
      const siteId = await verifiedSite();
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());

      await runCrawlJob(
        { db, payload: job!.payload!, now: new Date() },
        { network: explodingAfterDiscovery() },
      );

      const view = await getCrawl(contextFor('owner'), crawlId);
      expect(view.status).toBe('completed');
      expect(view.pagesFetched).toBe(0);
      expect(view.pagesFailed).toBeGreaterThan(0);
      expect(view.failureDetail).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // ⚠️ The failure path — a fault the crawl loop genuinely cannot absorb
  // -------------------------------------------------------------------------

  describe('⚠️ when the job throws mid-crawl', () => {
    /**
     * A database that dies after the first transaction.
     *
     * ⚠️ WHY NOT A FAILING TRANSPORT. The obvious fault — make the network
     * explode — does NOT throw: `runCrawl` records it as a failed page and
     * completes, which the test above now pins. To reach the handler's failure
     * path at all, the fault has to be one the crawl loop cannot turn into a
     * fact about a page. A connection lost mid-crawl is exactly that, and is a
     * real production failure rather than a contrived one.
     *
     * The first transaction is the claim, which must succeed — otherwise the
     * handler returns early and never enters the try block.
     */
    function dbFailingOn(...failing: number[]): Database {
      let calls = 0;
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async (...args: unknown[]) => {
              calls += 1;
              if (failing.includes(calls)) throw new Error('connection terminated unexpectedly');
              return (target.transaction as (...a: unknown[]) => unknown)(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as Database;
    }

    /**
     * Transaction 1 is the claim and must succeed, or the handler returns early
     * and never enters the try block. Transaction 2 is the crawl's first step.
     * Everything after recovers, so the failure CAN be recorded — a transient
     * blip rather than a dead process.
     */
    const blipOnFirstStep = () => dbFailingOn(2);

    it('leaves the crawl FAILED, not stuck in running', async () => {
      const siteId = await verifiedSite();
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());

      await expect(
        runCrawlJob(
          { db: blipOnFirstStep(), payload: job!.payload!, now: new Date() },
          { network: net(OPEN_SITE) },
        ),
      ).rejects.toThrow(/connection terminated/);

      // The assertion that matters. `running` here would be indistinguishable,
      // to an operator, from a crawl that is merely slow — forever.
      const view = await getCrawl(contextFor('owner'), crawlId);
      expect(view.status).toBe('failed');
      expect(view.completedAt).not.toBeNull();
    });

    it('RETHROWS, so the queue still sees a failure and retries', async () => {
      const siteId = await verifiedSite();
      await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());

      // Exactly what apps/worker/src/main.ts does around a handler.
      let threw = false;
      try {
        await runCrawlJob(
          { db: blipOnFirstStep(), payload: job!.payload!, now: new Date() },
          { network: net(OPEN_SITE) },
        );
      } catch (error) {
        threw = true;
        await failJob(db, job!, error, new Date());
      }

      expect(threw).toBe(true);
      const [row] = await harness.owner.select().from(jobs).where(eq(jobs.id, job!.id));
      // Swallowing the error would have left the crawl `running` and marked the
      // job completed — a failed crawl that looks successful in both tables.
      expect(row?.status).toBe('pending');
      expect(row?.lastError).toContain('connection terminated');
    });

    it('records a detail an operator can read, and no typed category it cannot', async () => {
      const siteId = await verifiedSite();
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());

      await expect(
        runCrawlJob(
          { db: blipOnFirstStep(), payload: job!.payload!, now: new Date() },
          { network: net(OPEN_SITE) },
        ),
      ).rejects.toThrow();

      const view = await getCrawl(contextFor('owner'), crawlId);
      expect(view.failureDetail).toBeTruthy();
      expect(view.failureDetail!.length).toBeLessThanOrEqual(200);
      expect(view.failureDetail).not.toContain('\n    at ');
      // ⚠️ NOT NULL. This test originally asserted null, and the database
      // refused the row: `crawls_failed_has_category` requires a failed crawl
      // to say why. Migration 0010 added `internal_error` rather than borrowing
      // a fetch category, because every other member describes what a FETCH did.
      expect(view.failureCategory).toBe('internal_error');
    });

    it('⚠️ when the database stays down, the ORIGINAL error still propagates', async () => {
      // Found by measurement, not designed for: with every transaction after
      // the claim failing, an unguarded markCrawlFailed threw its own error and
      // REPLACED the real one, so the queue recorded the bookkeeping failure
      // and the actual cause was lost. The crawl cannot be marked — recording a
      // failure needs the database, and the database is what failed — but the
      // caller must still learn what went wrong.
      const siteId = await verifiedSite();
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());

      await expect(
        runCrawlJob(
          { db: dbFailingOn(2, 3, 4, 5, 6, 7, 8), payload: job!.payload!, now: new Date() },
          { network: net(OPEN_SITE) },
        ),
      ).rejects.toThrow(/connection terminated/);

      // The row IS left running at this instant, because nothing could write to
      // it — recording a failure needs the database, and the database is what
      // failed. That was the gap dev log 0036 named; the test below closes it.
      expect((await getCrawl(contextFor('owner'), crawlId)).status).toBe('running');
    });

    it('⚠️ AND THE REAPER CLOSES IT: the stranded crawl ends up failed', async () => {
      // The exact scenario dev log 0036 left open, run end to end. Previously
      // this crawl stayed `running` forever, indistinguishable to an operator
      // from one that is merely slow. ADR-0055's reaper is what changes that.
      const siteId = await verifiedSite();
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());

      await expect(
        runCrawlJob(
          { db: dbFailingOn(2, 3, 4, 5, 6, 7, 8), payload: job!.payload!, now: new Date() },
          { network: net(OPEN_SITE) },
        ),
      ).rejects.toThrow(/connection terminated/);

      // Stranded, exactly as above.
      expect((await getCrawl(contextFor('owner'), crawlId)).status).toBe('running');

      // The database is back. A later worker pass reaps it — `now` is advanced
      // past the crawl's derived staleness bound rather than the clock being
      // waited on, which is the same trick `--once` uses for scheduling.
      const later = new Date(Date.now() + 500 * 30_000 + 31 * 60 * 1000);
      const reaped = await reapAbandonedCrawls(db, later);

      expect(reaped.map((r) => r.crawlId)).toEqual([crawlId]);

      const view = await getCrawl(contextFor('owner'), crawlId);
      expect(view.status).toBe('failed');
      expect(view.failureCategory).toBe('internal_error');
      expect(view.completedAt).not.toBeNull();
      expect(view.failureDetail).toBe(
        'The crawl stopped responding and was marked failed automatically.',
      );
    });

    it('the reaper does not touch a crawl the handler already marked failed', async () => {
      // The ordinary failure path still wins: a transient blip lets
      // markCrawlFailed succeed, and the reaper must find nothing to do.
      const siteId = await verifiedSite();
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());

      await expect(
        runCrawlJob(
          { db: blipOnFirstStep(), payload: job!.payload!, now: new Date() },
          { network: net(OPEN_SITE) },
        ),
      ).rejects.toThrow();

      const before = await getCrawl(contextFor('owner'), crawlId);
      expect(before.status).toBe('failed');

      const later = new Date(Date.now() + 500 * 30_000 + 31 * 60 * 1000);
      expect(await reapAbandonedCrawls(db, later)).toHaveLength(0);
      expect((await getCrawl(contextFor('owner'), crawlId)).completedAt).toBe(before.completedAt);
    });
  });

  // -------------------------------------------------------------------------

  describe('the at-least-once queue', () => {
    it('a SECOND delivery of the same job does not crawl twice', async () => {
      const siteId = await verifiedSite();
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });
      const [job] = await claimJobs(db, 5, new Date());
      const payload = job!.payload!;

      await runCrawlJob({ db, payload, now: new Date() }, { network: net(OPEN_SITE) });
      const after = await getCrawl(contextFor('owner'), crawlId);

      // Redelivery. The crawl is no longer `queued`, so the claim finds nothing
      // and the handler returns without re-running anything.
      await runCrawlJob({ db, payload, now: new Date() }, { network: net(OPEN_SITE) });

      const again = await getCrawl(contextFor('owner'), crawlId);
      expect(again.pagesFetched).toBe(after.pagesFetched);
      expect(
        (await harness.owner.select().from(crawlFrontier).where(eq(crawlFrontier.crawlId, crawlId)))
          .length,
      ).toBe(3);
    });

    it('a malformed payload fails the job and touches no crawl', async () => {
      await expect(runCrawlJob({ db, payload: {}, now: new Date() })).rejects.toThrow(
        /crawlId and workspaceId/,
      );
      expect(await harness.owner.select().from(crawls)).toHaveLength(0);
    });
  });
});
