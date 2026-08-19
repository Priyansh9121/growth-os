/**
 * The job that runs one crawl.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn a queued `crawls` row into a finished one, by composing three things
 * that already exist and adding no rule of its own: `claimCrawl` for the state
 * transition, `runCrawl` for the work, and the queue for delivery and retry.
 *
 * ⚠️ THIS IS THE FIRST CALLER `@growth-os/crawler` HAS EVER HAD.
 * Dev log 0035 measured that nothing in the repository imported it — not a
 * package, not a job, not a route. Every subsystem was built and tested in
 * isolation. This is where they become reachable by a person.
 *
 * ⚠️ IT RE-CHECKS NOTHING ABOUT AUTHORISATION, DELIBERATELY.
 * The verification gate and the capability check both ran at `requestCrawl`,
 * before the row existed (ADR-0054). A crawl row IS the authorisation: it could
 * not have been written without both gates passing. Re-checking here would put
 * an authorisation decision inside the worker, where there is no human to
 * authorise, and `runCrawl`'s own docblock refuses it for the same reason.
 *
 * ⚠️ A CRAWL THAT FAILS MUST NOT LOOK LIKE ONE STILL RUNNING.
 * The queue is at-least-once with backoff. Left alone, a handler that threw
 * would leave `status = 'running'` and a `startedAt` that never advances —
 * indistinguishable, to an operator, from a crawl that is simply slow. So the
 * run is wrapped, the row is marked `failed` honestly, and the error is
 * RETHROWN so the queue still applies its own retry policy. Swallowing it would
 * make a failed job look successful.
 *
 * @see docs/decisions/ADR-0054-starting-a-crawl.md
 * @see docs/decisions/ADR-0053-the-crawl-run.md
 */

import { eq } from 'drizzle-orm';
import { runCrawl, type CrawlRunResult } from '@growth-os/crawler';
import { schemaTables, withTenantTransaction, type Database } from '@growth-os/database';
import { productionNetwork, type SafeFetchDependencies } from '@growth-os/net';
import { claimCrawl, type SitesContext } from '@growth-os/sites';
import type { TenantActor } from '@growth-os/contracts';
import type { JobContext } from '../queue';

const { crawls } = schemaTables;

/**
 * The worker's authority to move a crawl row.
 *
 * ⚠️ A SYSTEM GRANT, NOT A ROLE (ADR-0025). There is no human here and the
 * honest record says so. The grant carries exactly `crawls:run` — the one
 * capability this job needs — rather than a role, because the weakest role
 * holding `crawls:run` also holds eighteen other things.
 *
 * `actorUserId` throws on a system context, so nothing downstream can write a
 * fabricated user id into `created_by_user_id`.
 */
function systemContext(
  db: Database,
  workspaceId: string,
  crawlId: string,
  now: Date,
): SitesContext {
  const workspace = {
    workspaceId,
    workspaceName: '',
    workspaceSlug: '',
    agencyId: null,
    // Never consulted: a system grant is the whole authority and is checked
    // INSTEAD of the role, so this value cannot widen anything.
    role: 'viewer' as const,
    via: 'direct' as const,
  };
  const tenant: TenantActor = {
    actor: {
      userId: '',
      email: '',
      name: '',
      sessionId: '',
      workspaces: [workspace],
      agencies: [],
    },
    workspace,
  };

  return {
    deps: { db, events: { publish: () => {} }, now: () => now },
    tenant,
    correlationId: null,
    system: { label: `crawl:${crawlId}`, capabilities: ['workspace:crawls:run'] },
  };
}

export interface RunCrawlJobDependencies {
  /** Injected so tests drive a fixture transport and never reach the network. */
  readonly network?: SafeFetchDependencies;
}

/**
 * Mark a crawl failed, without telling a customer something they cannot use.
 *
 * ⚠️ THE CATEGORY IS `internal_error`, AND THE DATABASE INSISTED ON IT.
 * This originally left `failure_category` null, on the reasoning that every
 * member of `CRAWL_FAILURE_CATEGORIES` described what a FETCH did and none
 * meant "the run threw". The `crawls_failed_has_category` CHECK from migration
 * 0008 refused the row — so the crawl was left `running` forever, which is the
 * exact state this function exists to prevent. The constraint was right and the
 * reasoning was wrong: migration 0010 names the case instead of borrowing a
 * fetch category and telling an operator a typed lie.
 */
async function markCrawlFailed(
  db: Database,
  workspaceId: string,
  crawlId: string,
  error: unknown,
  now: Date,
): Promise<void> {
  await withTenantTransaction(db, workspaceId, async (tx) => {
    await tx
      .update(crawls)
      .set({
        status: 'failed',
        completedAt: now,
        failureCategory: 'internal_error',
        // TRUNCATED, and never a URL or a stack trace. This value is shown to
        // a customer, and the column's own docblock requires that.
        failureDetail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      })
      .where(eq(crawls.id, crawlId));
  });
}

/**
 * Run the crawl named by the job payload.
 *
 * Idempotent on `crawl_id`, which the at-least-once queue requires: a second
 * delivery finds the row already `running`, `claimCrawl` returns null, and the
 * job completes without doing the work twice.
 */
export async function runCrawlJob(
  context: JobContext,
  deps: RunCrawlJobDependencies = {},
): Promise<void> {
  const crawlId = context.payload['crawlId'];
  const workspaceId = context.payload['workspaceId'];

  if (typeof crawlId !== 'string' || typeof workspaceId !== 'string') {
    // A malformed payload is a deploy skew or a bug, not a crawl failure.
    // There is no crawl row to mark, so this only fails the job.
    throw new Error('run-crawl requires string crawlId and workspaceId in its payload');
  }

  const sites = systemContext(context.db, workspaceId, crawlId, context.now);

  // The claim is the concurrency control. Zero rows means another delivery of
  // this same job already has it, or an operator cancelled it — either way
  // this delivery has no work, and that is a success, not a failure.
  const claimed = await claimCrawl(sites, crawlId);
  if (!claimed) return;

  try {
    const result: CrawlRunResult = await runCrawl(
      {
        network: deps.network ?? productionNetwork(),
        inTenant: (fn) => withTenantTransaction(context.db, workspaceId, fn),
        now: () => context.now,
      },
      {
        workspaceId,
        crawlId,
        siteId: claimed.siteId,
        // The crawl's own origin and budget, not the site's current ones. The
        // row is the record of what this run was asked to do.
        origin: claimed.origin,
        pageLimit: claimed.pageLimit,
        maxDepth: claimed.maxDepth,
      },
    );

    console.info('[worker] crawl finished', {
      crawlId,
      termination: result.termination,
      pagesFetched: result.pagesFetched,
      pagesFailed: result.pagesFailed,
    });
  } catch (error) {
    // Honest state first, THEN rethrow. The queue owns retry; this owns the
    // crawl row, and leaving it `running` would be a lie an operator cannot
    // distinguish from slowness.
    //
    // ⚠️ BEST-EFFORT, AND THE ORIGINAL ERROR ALWAYS WINS.
    // The write goes through the same database handle that may be the thing
    // that just failed. Found by a test: with a dying connection, an unguarded
    // `markCrawlFailed` threw its own error, which REPLACED the real one — so
    // the queue's `last_error` reported the bookkeeping failure and the actual
    // cause was lost. Whatever happens here, the caller sees what really went
    // wrong.
    try {
      await markCrawlFailed(context.db, workspaceId, crawlId, error, context.now);
    } catch (markError) {
      // Nothing else to try: recording a failure needs the database, and the
      // database is what failed. The crawl stays `running` until something
      // reaps it — named as a gap in dev log 0036 rather than papered over.
      console.error('[worker] could not mark crawl failed', { crawlId, markError });
    }
    throw error;
  }
}
