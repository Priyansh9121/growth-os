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

import { and, desc, eq, inArray } from 'drizzle-orm';
import { ConflictError, type CrawlStatus, type CrawlTrigger } from '@growth-os/contracts';
import {
  enqueue,
  schemaTables,
  withTenantTransaction,
  type Database,
  type TenantTransaction,
} from '@growth-os/database';
import {
  actorUserIdOrNull,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type SitesContext,
} from './context';

const { crawlFrontier, crawls, sites, workspaces } = schemaTables;

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

// ---------------------------------------------------------------------------
// Reaping crawls abandoned by a dead worker
// ---------------------------------------------------------------------------

/**
 * A wall-clock ceiling on one HTTP exchange, from `@growth-os/net`'s
 * `DEFAULT_TIMEOUTS.totalMs`.
 *
 * Duplicated as a number rather than imported, because importing it would make
 * a *timeout* the input to a *staleness* decision and couple the two silently:
 * a later session tuning the fetch timeout would move this threshold without
 * knowing. Stated here, a change to either one shows up as a disagreement
 * somebody has to resolve deliberately. Verified this session that
 * `pages/fetch.ts` does not override it.
 */
const REQUEST_CEILING_MS = 30_000;

/**
 * Robots plus the sitemap walk, which `maxSitemaps = 50` bounds.
 *
 * 51 exchanges × 30 s ≈ 25.5 minutes, rounded up. This is the part of a crawl
 * whose duration does not scale with `page_limit`.
 */
const DISCOVERY_SLACK_MS = 30 * 60 * 1000;

/**
 * When a crawl that started at `startedAt` can no longer be legitimately working.
 *
 * ⚠️ DERIVED, NEVER A CONSTANT, and the direction of the error is the point.
 * A crawl fetches one page at a time under a hard 30 s per-exchange ceiling, so
 * `page_limit × 30s` is a true upper bound on the page phase. A fixed threshold
 * cannot be right in both directions: tight enough to catch a dead 10-page
 * crawl promptly would reap a live 10,000-page one, and loose enough to be safe
 * for the latter would hide the former for days.
 *
 * Reaping late costs an operator some confusion. Reaping early destroys a
 * working crawl's record and writes a failure that never happened.
 *
 * @see docs/decisions/ADR-0055-reaping-abandoned-crawls.md
 */
export function crawlStaleAfter(startedAt: Date, pageLimit: number): Date {
  return new Date(startedAt.getTime() + pageLimit * REQUEST_CEILING_MS + DISCOVERY_SLACK_MS);
}

/** What a reaper pass did, so the worker can log something true. */
export interface ReapedCrawl {
  readonly crawlId: string;
  readonly workspaceId: string;
  readonly siteId: string;
  /** Frontier rows that were still queued or in flight when it was reaped. */
  readonly frontierAbandoned: number;
}

/** Safe for a customer to read: no host, no query, no stack trace. */
const REAPED_DETAIL = 'The crawl stopped responding and was marked failed automatically.';

/**
 * Mark crawls abandoned by a dead worker as failed, in one workspace.
 *
 * ⚠️ THE FRONTIER IS UPDATED BEFORE THE CRAWL, inside the same transaction.
 * Both or neither: a crawl marked failed whose frontier still claims rows are
 * in flight is the same half-written state this reaper exists to remove.
 */
async function reapWorkspace(
  tx: TenantTransaction,
  workspace: string,
  now: Date,
): Promise<ReapedCrawl[]> {
  // ⚠️ `started_at` IS SAFE TO KEY ON. `crawls_running_has_started_at` makes it
  // non-null for every row that is not `queued`, so the database guarantees the
  // comparison below is never against null.
  const stale = await tx
    .select({
      id: crawls.id,
      siteId: crawls.siteId,
      pageLimit: crawls.pageLimit,
      startedAt: crawls.startedAt,
    })
    .from(crawls)
    .where(and(tenantScope(crawls, workspace), eq(crawls.status, 'running')));

  const reaped: ReapedCrawl[] = [];

  for (const crawl of stale) {
    // The threshold is per crawl, so it cannot be a SQL predicate shared by all
    // of them without duplicating the derivation in two languages.
    if (!crawl.startedAt || crawlStaleAfter(crawl.startedAt, crawl.pageLimit) > now) continue;

    // ⚠️ `fetching` AND `queued`. `finishCrawl` only has to consider `queued`,
    // because it runs when the loop has stopped claiming. A crawl killed
    // mid-flight is precisely when a row is left claimed, and a row that says
    // it is in flight with nothing flying it is this bug's frontier version.
    const abandoned = await tx
      .update(crawlFrontier)
      .set({ state: 'skipped', skipReason: 'abandoned' })
      .where(
        and(
          eq(crawlFrontier.crawlId, crawl.id),
          inArray(crawlFrontier.state, ['queued', 'fetching']),
        ),
      )
      .returning({ id: crawlFrontier.id });

    // Conditional on `running` in SQL: another worker may have finished this
    // crawl legitimately between the select above and here, and its answer wins.
    const [row] = await tx
      .update(crawls)
      .set({
        status: 'failed',
        // Required by `crawls_failed_has_category`. `internal_error` is migration
        // 0010's category for "the run itself broke" rather than a fetch.
        failureCategory: 'internal_error',
        // Required by `crawls_terminal_status_has_completed_at`.
        completedAt: now,
        failureDetail: REAPED_DETAIL,
      })
      .where(
        and(eq(crawls.id, crawl.id), tenantScope(crawls, workspace), eq(crawls.status, 'running')),
      )
      .returning({ id: crawls.id });

    if (row) {
      reaped.push({
        crawlId: crawl.id,
        workspaceId: workspace,
        siteId: crawl.siteId,
        frontierAbandoned: abandoned.length,
      });
    }
  }

  return reaped;
}

/**
 * Reap every crawl abandoned by a dead worker, across all workspaces.
 *
 * The counterpart to `reclaimStalledJobs` — and deliberately NOT the same
 * shape, which is the finding ADR-0055 records.
 *
 * ⚠️ THE OBVIOUS IMPLEMENTATION UPDATES NOTHING, FOREVER.
 * `reclaimStalledJobs` is one unscoped `UPDATE` over `jobs`, which has no
 * row-level security. `crawls` and `crawl_frontier` are `ENABLE` **and**
 * `FORCE`. Measured against the restricted role production connects as, a
 * copied reaper affects **zero rows** — and so does the same statement inside
 * `withUnscopedTransaction`, which leaves `app_current_workspace_id()` null so
 * the tenant policy matches nothing. It would look exactly like a system with
 * no stale crawls.
 *
 * So the sweep enumerates workspaces — untenanted, therefore readable — and
 * opens one tenant transaction each. RLS is respected rather than escaped, and
 * no role gains `BYPASSRLS`.
 *
 * ⚠️ COST, STATED RATHER THAN HIDDEN: this is O(workspaces) per pass, not
 * O(stale crawls). Free at today's scale and untenable at ten thousand
 * workspaces; ADR-0055 names the `SECURITY DEFINER` discovery query as the fix
 * when that stops being true.
 *
 * @see docs/decisions/ADR-0055-reaping-abandoned-crawls.md
 */
export async function reapAbandonedCrawls(db: Database, now: Date): Promise<ReapedCrawl[]> {
  const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);

  const reaped: ReapedCrawl[] = [];
  for (const workspace of allWorkspaces) {
    const inWorkspace = await withTenantTransaction(db, workspace.id, (tx) =>
      reapWorkspace(tx, workspace.id, now),
    );
    reaped.push(...inWorkspace);
  }

  return reaped;
}
