/**
 * Requesting a crawl of a site, and reading what one found.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The two gates that stand between a person and outbound traffic to somebody
 * else's server, and nothing else. Every rule about HOW to crawl belongs to
 * `@growth-os/crawler`; this decides only WHETHER this caller may ask, and for
 * WHICH site.
 *
 * ⚠️ A CRAWL CANNOT BE QUEUED FOR AN UNVERIFIED SITE.
 * Not "cannot be run" — cannot be QUEUED. The check happens before any row is
 * written, so a refused request leaves no crawl and no job behind.
 *
 * ⚠️ WHY `safeFetch` DOING THE SSRF CHECKS IS NOT SUFFICIENT.
 * `safeFetch` decides whether an ADDRESS may be contacted. It cannot decide
 * whether this workspace has any business pointing us at that address, because
 * that is not a property of the address. `https://competitor.example` is an
 * ordinary public host: every SSRF control passes it, and every one of them
 * should. Without verification, Growth OS is an arbitrary internet-scanning
 * service anyone can drive by signing up and typing a domain — from our IP
 * addresses, with our user agent, at our legal risk (see `verification.ts`).
 *
 * The two controls are orthogonal. SSRF asks "is this address safe to
 * contact?". Verification asks "is this domain yours?". Neither substitutes for
 * the other, and both run.
 *
 * ⚠️ THE BUDGET IS THE SITE'S, NOT THE REQUEST'S.
 * `pageLimit` and `maxDepth` are read from the site row and copied onto the
 * crawl. A caller cannot supply them: how hard a server may be asked to work is
 * a property of that server, decided once by someone holding `crawls:manage`,
 * not per request by whoever pressed the button. Copying rather than joining is
 * deliberate — an old run stays explicable after the site is reconfigured.
 *
 * @see docs/decisions/ADR-0054-starting-a-crawl.md
 * @see docs/decisions/ADR-0031-site-verification.md
 */

import { and, desc, eq } from 'drizzle-orm';
import { ConflictError, type CrawlStatus, type CrawlTrigger } from '@growth-os/contracts';
import { enqueue, schemaTables } from '@growth-os/database';
import {
  actorUserIdOrNull,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type SitesContext,
} from './context';

const { crawls, sites } = schemaTables;

/**
 * The worker job that runs a crawl.
 *
 * Declared here rather than imported from `apps/worker`, because a package may
 * not import an app. The worker registers a handler under exactly this name;
 * an unknown job name fails visibly rather than being dropped, which is what
 * makes a deploy skew between the two a loud error instead of a silent one.
 */
export const RUN_CRAWL_JOB = 'run-crawl';

export interface RequestCrawlInput {
  readonly siteId: string;
  /** Defaults to `manual`. A scheduler passes `scheduled` with a system grant. */
  readonly trigger?: CrawlTrigger;
}

export interface CrawlRequested {
  readonly crawlId: string;
  readonly siteId: string;
  readonly origin: string;
  readonly status: CrawlStatus;
  readonly pageLimit: number;
  readonly maxDepth: number;
}

/**
 * Queue a crawl of a site this workspace has proven it owns.
 *
 * ⚠️ THE ROW AND ITS JOB COMMIT TOGETHER, in one tenant transaction. This is
 * the property ADR-0030 chose PostgreSQL for. Split apart, the two failures are
 * a job claiming a crawl that does not exist, and a crawl queued forever with
 * nothing coming to run it — neither of which reports anything.
 *
 * @throws AuthorizationError when the caller lacks `workspace:crawls:run`
 * @throws NotFoundError when the site is not this workspace's
 * @throws ConflictError when the site is not verified
 */
export async function requestCrawl(
  context: SitesContext,
  input: RequestCrawlInput,
): Promise<CrawlRequested> {
  // FIRST, so an unauthorised caller cannot use the error code to learn
  // whether a site exists or whether it is verified.
  requireCapability(context, 'workspace:crawls:run');

  return inTenant(context, async (tx, workspace) => {
    const site = await loadInTenant(tx, sites, workspace, input.siteId, 'Site');

    // ⚠️ THE GATE. Before any write, and it is a state problem rather than a
    // permission problem: the caller may well hold `crawls:run`, and the fix
    // is to verify the site. A 403 here would be both wrong and unactionable.
    if (site.verificationState !== 'verified') {
      throw new ConflictError(
        `Site ${site.id} is ${site.verificationState}, not verified — refusing to crawl ${site.origin}`,
        'Verify that you own this website before crawling it.',
      );
    }

    const now = contextNow(context);
    const [row] = await tx
      .insert(crawls)
      .values({
        workspaceId: workspace,
        siteId: site.id,
        status: 'queued',
        trigger: input.trigger ?? 'manual',
        // The origin AS IT IS NOW. A crawl is a historical measurement and its
        // subject is part of the measurement, so a later correction to the
        // site must not retroactively change what was crawled.
        origin: site.origin,
        pageLimit: site.crawlPageLimit,
        maxDepth: site.crawlMaxDepth,
        // Null for a scheduled crawl, which is the honest value — `trigger`
        // says who, and `actorUserIdOrNull` refuses to invent a human.
        createdByUserId: actorUserIdOrNull(context),
        createdAt: now,
      })
      .returning();

    if (!row) throw new Error('Failed to create crawl');

    // Same transaction as the row above. `dedupeKey` is the crawl id, so a
    // retried request cannot produce two jobs for one crawl.
    await enqueue(tx, {
      name: RUN_CRAWL_JOB,
      payload: { crawlId: row.id, workspaceId: workspace },
      runAt: now,
      dedupeKey: `${RUN_CRAWL_JOB}:${row.id}`,
    });

    return {
      crawlId: row.id,
      siteId: row.siteId,
      origin: row.origin,
      status: row.status,
      pageLimit: row.pageLimit,
      maxDepth: row.maxDepth,
    };
  });
}

/**
 * What a crawl did.
 *
 * ⚠️ FACTS, NEVER FINDINGS (§5). Every field here is something that happened:
 * a status, a count, a typed outcome. "Your robots.txt is misconfigured" is
 * Stage 5's sentence to write, from these values, and putting it here would
 * bury the judgement in the collection layer where changing it means recrawling.
 */
export interface CrawlView {
  readonly id: string;
  readonly siteId: string;
  readonly origin: string;
  readonly status: CrawlStatus;
  readonly trigger: CrawlTrigger;
  readonly pageLimit: number;
  readonly maxDepth: number;
  readonly robotsOutcome: string | null;
  readonly sitemapOutcome: string | null;
  readonly sitemapUrlCount: number;
  readonly pagesDiscovered: number;
  readonly pagesFetched: number;
  readonly pagesFailed: number;
  readonly pagesSkipped: number;
  readonly bytesDownloaded: number;
  readonly failureCategory: string | null;
  readonly failureDetail: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function toView(row: typeof crawls.$inferSelect): CrawlView {
  return {
    id: row.id,
    siteId: row.siteId,
    origin: row.origin,
    status: row.status,
    trigger: row.trigger,
    pageLimit: row.pageLimit,
    maxDepth: row.maxDepth,
    robotsOutcome: row.robotsOutcome,
    sitemapOutcome: row.sitemapOutcome,
    sitemapUrlCount: row.sitemapUrlCount,
    pagesDiscovered: row.pagesDiscovered,
    pagesFetched: row.pagesFetched,
    pagesFailed: row.pagesFailed,
    pagesSkipped: row.pagesSkipped,
    bytesDownloaded: row.bytesDownloaded,
    failureCategory: row.failureCategory,
    failureDetail: row.failureDetail,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/**
 * One crawl's status and result.
 *
 * `crawls:read`, not `crawls:run` — a viewer sees what a crawl found and cannot
 * start one.
 *
 * @throws NotFoundError when the crawl is not this workspace's
 */
export async function getCrawl(context: SitesContext, crawlId: string): Promise<CrawlView> {
  requireCapability(context, 'workspace:crawls:read');

  return inTenant(context, async (tx, workspace) => {
    const row = await loadInTenant(tx, crawls, workspace, crawlId, 'Crawl');
    return toView(row);
  });
}

/** A site's crawls, newest first — the index `crawls_site_created_idx` serves. */
export async function listCrawlsForSite(
  context: SitesContext,
  siteId: string,
  limit = 20,
): Promise<readonly CrawlView[]> {
  requireCapability(context, 'workspace:crawls:read');

  return inTenant(context, async (tx, workspace) => {
    // Loaded through the same tenant-scoped path as everything else: a site id
    // from another workspace resolves to nothing rather than to a refusal that
    // would confirm the row exists.
    const rows = await tx
      .select()
      .from(crawls)
      .where(and(tenantScope(crawls, workspace), eq(crawls.siteId, siteId)))
      .orderBy(desc(crawls.createdAt))
      .limit(limit);

    return rows.map(toView);
  });
}

/**
 * Move a queued crawl to `running`, or report that it is not startable.
 *
 * ⚠️ THE STATUS CHANGE IS THE CLAIM, and it is conditional in SQL rather than
 * read-then-write. The queue is at-least-once: the same job can be delivered
 * twice, and two workers reading `queued` before either writes `running` would
 * both run the same crawl. `where status = 'queued'` returning zero rows is how
 * the second one finds out it lost.
 *
 * `runCrawl` requires the row to already be `running`, which is why this exists
 * separately rather than inside it.
 */
export async function claimCrawl(
  context: SitesContext,
  crawlId: string,
): Promise<CrawlView | null> {
  return inTenant(context, async (tx, workspace) => {
    const now = contextNow(context);
    const [row] = await tx
      .update(crawls)
      .set({ status: 'running', startedAt: now })
      .where(
        // Identity, tenant scope AND the status precondition, in ONE statement.
        // A read-then-write would leave the window this exists to close.
        and(eq(crawls.id, crawlId), tenantScope(crawls, workspace), eq(crawls.status, 'queued')),
      )
      .returning();

    // Zero rows means: not ours, gone, or already claimed by another delivery
    // of the same job. All three are "you did not get it", and the caller must
    // not be able to tell them apart.
    return row ? toView(row) : null;
  });
}
