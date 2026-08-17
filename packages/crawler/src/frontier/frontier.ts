/**
 * The durable crawl frontier.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * What has been discovered, what is queued, what was fetched, and what was
 * refused and why — in PostgreSQL, not in a `Set`.
 *
 * ⚠️ WHY THE DATABASE AND NOT MEMORY
 * A worker that dies mid-crawl must not forget what it had already discovered.
 * The in-memory alternative costs a customer's server a complete re-fetch of
 * every page it already served, which is both slower and ruder than remembering
 * — and it makes cancellation and resume impossible to reason about.
 *
 * ⚠️ THIS IS A DATA LAYER, NOT A SERVICE. IT TAKES A TRANSACTION.
 * There is deliberately no `CrawlContext` here, and no capability check. The
 * repository already carries three near-identical context objects (`CrmContext`,
 * `FormsContext`, `SitesContext`); a fourth would be duplication for its own
 * sake. More importantly, authorisation belongs where a crawl is STARTED — the
 * caller has already proved `workspace:crawls:run` — and re-checking it per URL
 * would put an authorisation decision inside a loop that runs thousands of
 * times, which is how one eventually gets removed for being slow.
 *
 * Every function takes a tenant-scoped transaction, so RLS applies exactly as it
 * does for a request handler. The worker's database access is not a way around
 * the tenant boundary.
 *
 * @see docs/decisions/ADR-0036-frontier-budget-and-ceiling.md
 */

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import {
  decideEnqueue,
  terminationReason,
  type Candidate,
  type FrontierBudget,
  type TerminationReason,
} from './decide';
import { normaliseUrl } from '../urls/normalise';
import type { RobotsRules } from '../robots/parse';
import type { CrawlScope } from '../urls/scope';

const { crawlFrontier, crawlPages, crawls, sitePages } = schemaTables;

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueEnvironment {
  readonly scope: CrawlScope;
  readonly robots: RobotsRules;
  readonly siteDisallowed: boolean;
  readonly budget: FrontierBudget;
}

export interface EnqueueSummary {
  /** Accepted and written as `queued`. */
  readonly queued: number;
  /** Recorded as `skipped`, with a reason. Still discovered. */
  readonly skipped: number;
  /** Already present in this crawl. Not written again, not counted twice. */
  readonly duplicates: number;
  /**
   * ⚠️ Candidates the row ceiling left no room to record AT ALL.
   *
   * Non-zero means this crawl's discovered total is an undercount, and the
   * caller must record that rather than report a shorter list as complete.
   */
  readonly unrecorded: number;
  readonly skippedForDepth: boolean;
}

/**
 * Offer candidates to the frontier.
 *
 * ⚠️ DEDUPLICATION IS THE DATABASE'S JOB, NOT A PRE-CHECK.
 *
 * The unique index on `(crawl_id, normalised_url)` decides. A read-then-write
 * would race exactly where it matters: every page on a site links to
 * `/contact`, so two page workers discovering it in the same millisecond is the
 * normal case rather than an edge one. `ON CONFLICT DO NOTHING` makes the second
 * insert a no-op instead of a duplicate row or a crash.
 *
 * The candidates are also deduplicated in memory first, because one page
 * routinely links to the same URL twice and a single statement cannot conflict
 * with itself.
 */
export async function enqueueDiscovered(
  tx: TenantTransaction,
  workspaceId: string,
  crawlId: string,
  environment: EnqueueEnvironment,
  candidates: readonly Candidate[],
  discoveredFrom: string | null = null,
): Promise<EnqueueSummary> {
  // ⚠️ NORMALISE AND DEDUPLICATE BEFORE DECIDING, NOT AFTER.
  //
  // This ordering is a bug fix, and the bug is worth remembering. The first
  // version decided every candidate and let the unique index reject the
  // duplicates — but the running budget counter had already been incremented for
  // them. Every page links back to the root and to its siblings, so a page with
  // ten links of which eight were already known consumed eight units of a budget
  // it never spent. A crawl configured for 4 pages fetched 1 and then reported
  // that the frontier was empty.
  //
  // A duplicate is not a decision. It is a no-op, and it must cost nothing.
  const normalised = candidates.map((candidate) => ({
    candidate,
    normalisedUrl: normaliseUrl(candidate.url, {
      ...(candidate.base ? { base: candidate.base } : {}),
    }),
  }));

  const knownUrls = normalised
    .map((entry) => entry.normalisedUrl)
    .filter((url): url is string => url !== null);

  const existing = new Set<string>();
  if (knownUrls.length > 0) {
    const rows = await tx
      .select({ url: crawlFrontier.normalisedUrl })
      .from(crawlFrontier)
      .where(
        and(eq(crawlFrontier.crawlId, crawlId), inArray(crawlFrontier.normalisedUrl, knownUrls)),
      );
    for (const row of rows) existing.add(row.url);
  }

  const counts = await frontierCounts(tx, crawlId);

  // Running counts, so a batch cannot overshoot a limit the first row in it was
  // still under.
  let rows = counts.rows;
  let fetchable = counts.fetchable;

  /** Candidates the ceiling left no room for. */
  let unrecorded = 0;
  /** Candidates that were never a URL — counted as discovered, given no row. */
  let nonUrl = 0;
  /** Already present in this crawl, or repeated within this batch. */
  let duplicates = 0;
  let skippedForDepth = false;

  const seen = new Set<string>();
  const toInsert: (typeof crawlFrontier.$inferInsert)[] = [];

  for (const { candidate, normalisedUrl } of normalised) {
    if (normalisedUrl === null) {
      // No identity to store against. Counted so the discovered total stays
      // honest, without a row whose `normalised_url` would have to be a lie.
      nonUrl += 1;
      continue;
    }

    // Already in the frontier, or repeated within this batch — one page
    // routinely links to the same URL twice.
    if (existing.has(normalisedUrl) || seen.has(normalisedUrl)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalisedUrl);

    const decision = decideEnqueue({
      candidate,
      scope: environment.scope,
      robots: environment.robots,
      siteDisallowed: environment.siteDisallowed,
      budget: environment.budget,
      counts: { rows, fetchable },
    });

    if (!decision.accept && decision.skipReason === 'depth_limit') skippedForDepth = true;

    if (!decision.accept && decision.unrecordable) {
      unrecorded += 1;
      continue;
    }

    toInsert.push({
      workspaceId,
      crawlId,
      normalisedUrl,
      state: decision.accept ? 'queued' : 'skipped',
      skipReason: decision.accept ? null : decision.skipReason,
      depth: decision.accept ? decision.depth : candidate.depth,
      discoverySource: candidate.source,
      discoveredFrom,
    });

    rows += 1;
    if (decision.accept) fetchable += 1;
  }

  // `onConflictDoNothing` remains, and is not redundant: the read above is not a
  // lock, so two workers can both see a URL as absent. The index is what makes
  // the second insert a no-op instead of a crash — the read is an optimisation
  // for the common case and the constraint is the guarantee.
  const written =
    toInsert.length === 0
      ? []
      : await tx
          .insert(crawlFrontier)
          .values(toInsert)
          .onConflictDoNothing({ target: [crawlFrontier.crawlId, crawlFrontier.normalisedUrl] })
          .returning({ id: crawlFrontier.id, state: crawlFrontier.state });

  const queued = written.filter((row) => row.state === 'queued').length;

  return {
    queued,
    skipped: nonUrl + (written.length - queued),
    duplicates: duplicates + (toInsert.length - written.length),
    unrecorded,
    skippedForDepth,
  };
}

/**
 * Seed a crawl from its site's origin.
 *
 * ⚠️ THE SEED GOES THROUGH THE SAME DECISION AS EVERY OTHER URL.
 *
 * It is tempting to insert the root directly — it is in scope by definition, and
 * depth 0 cannot exceed a limit. But `robots.txt` can disallow `/`, and a seed
 * inserted around the decision would fetch the one page the site most clearly
 * refused. It also means the seed's identity is normalised by the same function
 * as everything else, so `https://example.test` and `https://example.test/` are
 * not two roots.
 */
export async function seedFrontier(
  tx: TenantTransaction,
  workspaceId: string,
  crawlId: string,
  environment: EnqueueEnvironment,
  origin: string,
): Promise<EnqueueSummary> {
  return enqueueDiscovered(tx, workspaceId, crawlId, environment, [
    { url: `${origin.replace(/\/$/, '')}/`, depth: 0, source: 'seed' },
  ]);
}

// ---------------------------------------------------------------------------
// Claim and complete
// ---------------------------------------------------------------------------

export interface ClaimedUrl {
  readonly id: string;
  readonly normalisedUrl: string;
  readonly depth: number;
}

/**
 * Take the next batch of work.
 *
 * `FOR UPDATE SKIP LOCKED`, the same mechanism as the job queue (ADR-0030):
 * each caller takes rows nothing else holds and skips the rest, so two page
 * workers never claim the same URL and neither blocks.
 *
 * Oldest first — breadth-first-ish, which is what makes a page-limited crawl
 * cover a site's top levels rather than one deep branch of it.
 */
export async function claimNext(
  tx: TenantTransaction,
  crawlId: string,
  batchSize: number,
  now: Date,
): Promise<readonly ClaimedUrl[]> {
  const claimed = await tx
    .update(crawlFrontier)
    .set({ state: 'fetching', claimedAt: now })
    .where(
      inArray(
        crawlFrontier.id,
        tx
          .select({ id: crawlFrontier.id })
          .from(crawlFrontier)
          .where(and(eq(crawlFrontier.crawlId, crawlId), eq(crawlFrontier.state, 'queued')))
          .orderBy(asc(crawlFrontier.depth), asc(crawlFrontier.createdAt))
          .limit(batchSize)
          .for('update', { skipLocked: true }),
      ),
    )
    .returning({
      id: crawlFrontier.id,
      normalisedUrl: crawlFrontier.normalisedUrl,
      depth: crawlFrontier.depth,
    });

  return claimed;
}

/**
 * Attach a fetched URL to its DURABLE page identity, and mark it done.
 *
 * ⚠️ ONE TRANSACTION, THREE WRITES, AND THAT IS THE POINT.
 *
 * `site_pages` (identity, upserted), `crawl_pages` (the observation) and the
 * frontier row's state must move together. A worker dying between them would
 * leave a fetched page whose observation is missing, or an observation with no
 * identity to diff against — the exact incoherence horizon #1 exists to prevent.
 *
 * The caller supplies the transaction, so this composes into whatever larger
 * unit the page worker needs.
 */
export async function markFetched(
  tx: TenantTransaction,
  workspaceId: string,
  input: {
    readonly crawlId: string;
    readonly siteId: string;
    readonly frontierId: string;
    readonly normalisedUrl: string;
    readonly depth: number;
    readonly now: Date;
    /** Facts. Never a severity, never a recommendation (§5). */
    readonly observation: Record<string, unknown>;
  },
): Promise<{ readonly sitePageId: string }> {
  // ⚠️ UPSERT, not insert-if-absent. `site_pages` is unique on
  // `(site_id, normalised_url)` for ALL TIME, so the second crawl of a page
  // finds the row the first crawl made and only moves `last_seen_at`.
  const [page] = await tx
    .insert(sitePages)
    .values({
      workspaceId,
      siteId: input.siteId,
      normalisedUrl: input.normalisedUrl,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
    })
    .onConflictDoUpdate({
      target: [sitePages.siteId, sitePages.normalisedUrl],
      // `first_seen_at` is NEVER touched on conflict. It is the one fact this
      // table exists to remember, and overwriting it would make "how long has
      // this page existed?" answer "since the last crawl".
      set: { lastSeenAt: input.now },
    })
    .returning({ id: sitePages.id });

  if (!page) throw new Error('site_pages upsert returned no row');

  await tx
    .insert(crawlPages)
    .values({
      workspaceId,
      crawlId: input.crawlId,
      siteId: input.siteId,
      sitePageId: page.id,
      normalisedUrl: input.normalisedUrl,
      depth: input.depth,
      fetchedAt: input.now,
      ...input.observation,
    } as typeof crawlPages.$inferInsert)
    // At-least-once delivery means a page job will sometimes run twice. The
    // unique index makes the retry idempotent rather than doubling every count.
    .onConflictDoNothing({ target: [crawlPages.crawlId, crawlPages.normalisedUrl] });

  await tx
    .update(crawlFrontier)
    .set({ state: 'fetched', fetchedAt: input.now })
    .where(eq(crawlFrontier.id, input.frontierId));

  return { sitePageId: page.id };
}

/** A claimed URL that failed past its retry ceiling. Still discovered, not fetched. */
export async function markFailed(
  tx: TenantTransaction,
  frontierId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(crawlFrontier)
    .set({ state: 'failed', fetchedAt: now, attempts: sql`${crawlFrontier.attempts} + 1` })
    .where(eq(crawlFrontier.id, frontierId));
}

// ---------------------------------------------------------------------------
// Counts and termination
// ---------------------------------------------------------------------------

export interface Counts {
  readonly rows: number;
  readonly fetchable: number;
  readonly queued: number;
}

/**
 * ⚠️ `fetchable` IS WHAT `pageLimit` BOUNDS: rows that are queued, being
 * fetched, or already fetched — every URL that will consume a request. Skipped
 * and failed rows are excluded, which is the whole of ADR-0036's reading.
 */
export async function frontierCounts(tx: TenantTransaction, crawlId: string): Promise<Counts> {
  const [row] = await tx
    .select({
      rows: count(),
      fetchable: sql<number>`count(*) filter (where ${crawlFrontier.state} in ('queued','fetching','fetched'))::int`,
      queued: sql<number>`count(*) filter (where ${crawlFrontier.state} = 'queued')::int`,
    })
    .from(crawlFrontier)
    .where(eq(crawlFrontier.crawlId, crawlId));

  return { rows: Number(row?.rows ?? 0), fetchable: row?.fetchable ?? 0, queued: row?.queued ?? 0 };
}

export interface CrawlProgress {
  readonly reason: TerminationReason | null;
  readonly counts: Counts;
}

/**
 * Should the loop continue?
 *
 * ⚠️ CANCELLATION IS READ FROM THE DATABASE, NOT FROM A FLAG IN THE PROCESS.
 * The operator presses Cancel in a web request; the worker is a different
 * process. `cancel_requested_at` is how the two communicate, and reading it here
 * — once per pass rather than once per URL — is what makes cancellation take
 * effect promptly without turning every URL into a query.
 */
export async function crawlProgress(
  tx: TenantTransaction,
  crawlId: string,
  skippedForDepth: boolean,
): Promise<CrawlProgress> {
  const [crawl] = await tx
    .select({
      pageLimit: crawls.pageLimit,
      cancelRequestedAt: crawls.cancelRequestedAt,
      status: crawls.status,
    })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);

  if (!crawl) throw new Error(`Crawl ${crawlId} not found in this workspace`);

  const counts = await frontierCounts(tx, crawlId);

  return {
    counts,
    reason: terminationReason({
      cancelRequested: crawl.cancelRequestedAt !== null || crawl.status === 'cancelled',
      queued: counts.queued,
      fetchable: counts.fetchable,
      pageLimit: crawl.pageLimit,
      skippedForDepth,
    }),
  };
}

/**
 * Stop scheduling, and record why — honestly.
 *
 * ⚠️ A CANCELLED CRAWL IS `cancelled`, NEVER `completed`.
 *
 * Whatever else was true when it stopped, the operator's decision is the reason
 * it stopped, and a status of `completed` would claim coverage the crawl does
 * not have. The remaining queued rows are marked `skipped` with reason
 * `cancelled` rather than deleted: they were genuinely discovered, and erasing
 * them would make the discovered total shrink retroactively.
 *
 * Already-fetched pages are untouched. Cancellation stops future work; it does
 * not invalidate work that completed.
 */
export async function finishCrawl(
  tx: TenantTransaction,
  crawlId: string,
  reason: TerminationReason,
  now: Date,
): Promise<void> {
  await tx
    .update(crawlFrontier)
    .set({ state: 'skipped', skipReason: 'cancelled' })
    .where(and(eq(crawlFrontier.crawlId, crawlId), eq(crawlFrontier.state, 'queued')));

  const counts = await frontierCounts(tx, crawlId);

  await tx
    .update(crawls)
    .set({
      status: reason === 'cancelled' ? 'cancelled' : 'completed',
      completedAt: now,
      pagesDiscovered: counts.rows,
    })
    .where(eq(crawls.id, crawlId));
}
