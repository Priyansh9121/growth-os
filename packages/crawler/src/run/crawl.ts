/**
 * One crawl run.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Compose three tested subsystems in the one order their own ADRs permit, and
 * add no rules of its own. Every admission decision is `decideEnqueue`'s, every
 * permission decision is robots', every bound is the frontier's.
 *
 * ⚠️ ROBOTS → SITEMAP → PAGES, AND THE ORDER IS NOT A PREFERENCE.
 * ADR-0035 makes an unreadable `robots.txt` disallow the whole site, so its
 * outcome gates everything after it. ADR-0051 makes a missing sitemap normal,
 * so it stops nothing. Any other order contradicts one of them.
 *
 * ⚠️ A TRANSACTION PER STEP, NEVER ONE ACROSS THE RUN.
 * A crawl is minutes of network I/O. Holding a tenant transaction open across
 * it would pin a connection for the whole run and hold row locks while waiting
 * on somebody else's server. `inTenant` is injected so each database step opens
 * and closes its own, and the caller decides what a transaction is.
 *
 * ⚠️ LINKS ARE THE THIRD SOURCE OF CANDIDATES, AFTER THE SEED AND SITEMAPS.
 * `fetchPage` returns what the document stated (ADR-0068); this records it and
 * offers the internal half to the frontier. A site with no sitemap is no longer
 * a one-page crawl.
 *
 * It still adds no rule of its own: `linkCandidates` decides nothing a
 * `classifyScope` verdict did not already say, and every admission decision
 * remains `decideEnqueue`'s.
 *
 * @see docs/decisions/ADR-0053-the-crawl-run.md
 * @see docs/decisions/ADR-0069-discovered-links-become-frontier-candidates.md
 */

import type { SitemapOutcome } from '@growth-os/contracts';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import type { SafeFetchDependencies } from '@growth-os/net';
import { eq } from 'drizzle-orm';
import { fetchRobots, type RobotsFetchOutcome } from '../robots/fetch';
import { enqueueFromSitemap } from '../sitemap/enqueue';
import {
  frontierRowCeiling,
  type FrontierBudget,
  type TerminationReason,
} from '../frontier/decide';
import {
  claimNext,
  crawlProgress,
  enqueueDiscovered,
  finishCrawl,
  markFailed,
  markFetched,
  seedFrontier,
  type EnqueueEnvironment,
} from '../frontier/frontier';
import { linkCandidates, recordLinks } from '../links/record';
import { fetchPage } from '../pages/fetch';
import { crawlScope } from '../urls/scope';

const { crawls } = schemaTables;

export interface CrawlRunDependencies {
  readonly network: SafeFetchDependencies;
  /** Opens a tenant-scoped transaction. One per step, never one for the run. */
  readonly inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
  readonly now: () => Date;
}

export interface CrawlRunInput {
  readonly workspaceId: string;
  readonly crawlId: string;
  readonly siteId: string;
  /** The origin as the crawl row recorded it. Not re-read from the site. */
  readonly origin: string;
  readonly pageLimit: number;
  readonly maxDepth: number;
}

export interface CrawlRunResult {
  readonly robots: RobotsFetchOutcome;
  readonly sitemap: SitemapOutcome;
  readonly sitemapUrlCount: number;
  readonly pagesFetched: number;
  readonly pagesFailed: number;
  readonly bytesDownloaded: number;
  readonly termination: TerminationReason;
}

/**
 * Map the fetch layer's sitemap outcome onto the column's vocabulary.
 *
 * ⚠️ THE TWO ENUMS DISAGREE, AND NEITHER IS WRONG. `truncated` and `skipped`
 * are facts only the orchestrator knows — was the walk cut short, was a sitemap
 * looked for at all. `unavailable` and `not_a_sitemap` are facts only the fetch
 * layer knows. This is where the two vantage points meet.
 *
 * ⚠️ `not_a_sitemap` becomes `error`, NOT `absent`. ADR-0051 separated them
 * deliberately: reporting a 200-with-an-HTML-404-page as "absent" is a small
 * lie an operator cannot debug, and mapping it back re-introduces exactly that.
 */
function sitemapOutcomeFor(
  fetched: 'fetched' | 'absent' | 'unavailable' | 'error' | 'not_a_sitemap',
  truncated: boolean,
): SitemapOutcome {
  if (fetched === 'absent') return 'absent';
  if (fetched === 'fetched') return truncated ? 'truncated' : 'fetched';
  return 'error';
}

/**
 * Run one crawl to completion.
 *
 * The crawl row must already exist, already be `running`, and already have been
 * authorised — this function checks no capability, because authorisation
 * belongs where a crawl is STARTED and re-checking it here would put an
 * authorisation decision inside a loop.
 */
export async function runCrawl(
  deps: CrawlRunDependencies,
  input: CrawlRunInput,
): Promise<CrawlRunResult> {
  const budget: FrontierBudget = {
    pageLimit: input.pageLimit,
    maxDepth: input.maxDepth,
    maxRows: frontierRowCeiling(input.pageLimit),
  };

  // ---- 1. robots.txt, whose outcome gates everything after it -------------
  const robots = await fetchRobots(deps.network, input.origin);

  const environment: EnqueueEnvironment = {
    scope: crawlScope(input.origin),
    robots: robots.rules,
    siteDisallowed: robots.siteDisallowed,
    budget,
  };

  await deps.inTenant((tx) =>
    seedFrontier(tx, input.workspaceId, input.crawlId, environment, input.origin),
  );

  // ---- 2. the sitemap, if we are permitted to act on one ------------------
  //
  // ⚠️ NOT LOOKED FOR WHEN THE SITE IS DISALLOWED. Not because the frontier
  // would fail to refuse the URLs — it would, every one of them — but because
  // fetching a sitemap we have no permission to act on is a request against a
  // server that already told us it could not answer.
  let sitemap: SitemapOutcome = 'skipped';
  let sitemapUrlCount = 0;

  if (!robots.siteDisallowed) {
    // ⚠️ ROBOTS' OWN `Sitemap:` LINES FIRST. They are the site's declaration of
    // where its sitemap is; `/sitemap.xml` is a guess we fall back to.
    const declared = robots.rules.sitemaps;
    const startUrls =
      declared.length > 0 ? declared : [`${input.origin.replace(/\/$/, '')}/sitemap.xml`];

    for (const startUrl of startUrls) {
      const result = await deps.inTenant((tx) =>
        enqueueFromSitemap(
          tx,
          input.workspaceId,
          input.crawlId,
          environment,
          deps.network,
          startUrl,
        ),
      );

      sitemapUrlCount += result.walk.candidates.length;
      const first = result.walk.visited[0]?.outcome ?? 'error';
      const outcome = sitemapOutcomeFor(first, result.walk.stopped.length > 0);
      // The best outcome across declared sitemaps wins: one unreadable sitemap
      // among several does not make the crawl's sitemap state an error.
      if (sitemap === 'skipped' || outcome === 'fetched') sitemap = outcome;
    }
  }

  // ---- 3. the page loop --------------------------------------------------
  let pagesFetched = 0;
  let pagesFailed = 0;
  let bytesDownloaded = 0;
  let termination: TerminationReason = 'frontier_empty';

  // ⚠️ `crawlProgress` IS THE REASON REPORTER, NOT THE LOOP CONDITION — and the
  // difference was found by composing these for the first time.
  //
  // `terminationReason` returns `budget_exhausted` as soon as
  // `fetchable >= pageLimit`, and `frontierCounts` counts a row as fetchable
  // while it is still `queued`. Since `decideEnqueue` admits at most
  // `pageLimit` fetchable rows, that condition is true the moment admission
  // fills the budget — before a single page has been fetched. Using it as the
  // loop condition made a crawl with `pageLimit: 2` fetch **zero** pages.
  //
  // So the loop ends when there is nothing left to claim, and `crawlProgress`
  // is asked afterwards WHY. Neither function is changed: the reading is what
  // was wrong, not the code (§3).
  for (;;) {
    // ⚠️ CANCELLATION IS THE ONE REASON CHECKED BEFORE CLAIMING. The operator
    // who pressed Cancel is in a different process and expects it to take
    // effect promptly, not after one more page is fetched.
    const beforeClaim = await deps.inTenant((tx) => crawlProgress(tx, input.crawlId, false));
    if (beforeClaim.reason === 'cancelled') {
      termination = 'cancelled';
      break;
    }

    const claimed = await deps.inTenant((tx) => claimNext(tx, input.crawlId, 1, deps.now()));
    if (claimed.length === 0) {
      // Nothing queued. `crawlProgress` says whether that is because the budget
      // filled, the depth limit bit, or the site simply ended.
      const final = await deps.inTenant((tx) => crawlProgress(tx, input.crawlId, false));
      termination = final.reason ?? 'frontier_empty';
      break;
    }

    for (const url of claimed) {
      // ⚠️ THE FULL SSRF PIPELINE, AGAIN. This URL passed admission once; DNS
      // can resolve differently now. See ADR-0053.
      const { observation, links } = await fetchPage(deps.network, url.normalisedUrl, {
        scope: environment.scope,
      });
      bytesDownloaded += observation.bytes;

      const succeeded = observation.outcome === 'fetched' || observation.outcome === 'unchanged';
      if (succeeded) pagesFetched += 1;
      else pagesFailed += 1;

      await deps.inTenant(async (tx) => {
        if (!succeeded) {
          await markFailed(tx, url.id, deps.now());
          return;
        }

        const { crawlPageId } = await markFetched(tx, input.workspaceId, {
          crawlId: input.crawlId,
          siteId: input.siteId,
          frontierId: url.id,
          normalisedUrl: url.normalisedUrl,
          depth: url.depth,
          now: deps.now(),
          observation: { ...observation, bytes: undefined },
        });

        // ⚠️ NULL MEANS THIS PAGE WAS ALREADY RECORDED IN THIS CRAWL — an
        // at-least-once redelivery, not a failure. Its links were written by
        // the attempt that created the observation, in this same transaction,
        // so writing them again would duplicate every one of them:
        // `crawl_links` has no unique index to refuse them (ADR-0067).
        if (crawlPageId === null) return;

        await recordLinks(tx, input.workspaceId, {
          crawlId: input.crawlId,
          sourcePageId: crawlPageId,
          links,
        });

        // ⚠️ `url.id` IS THE FRONTIER ROW, WHICH IS WHAT THE COLUMN WANTS.
        // `discovered_from` is a uuid self-reference to `crawl_frontier.id`,
        // not a URL — the sitemap path documents having got that wrong once.
        // Here there IS a row to point at, because the page that stated these
        // links was itself claimed from the frontier.
        await enqueueDiscovered(
          tx,
          input.workspaceId,
          input.crawlId,
          environment,
          linkCandidates(links, url.depth + 1),
          url.id,
        );
      });
    }
  }

  // ---- 4. finish, and record what the run learned -------------------------
  await deps.inTenant(async (tx) => {
    await finishCrawl(tx, input.crawlId, termination, deps.now());
    // ⚠️ `finishCrawl` sets status, completedAt and pagesDiscovered ONLY.
    // These columns are the run's, so the run writes them.
    await tx
      .update(crawls)
      .set({
        robotsOutcome: robots.outcome,
        sitemapOutcome: sitemap,
        sitemapUrlCount,
        pagesFetched,
        pagesFailed,
        bytesDownloaded,
      })
      .where(eq(crawls.id, input.crawlId));
  });

  return {
    robots: robots.outcome,
    sitemap,
    sitemapUrlCount,
    pagesFetched,
    pagesFailed,
    bytesDownloaded,
    termination,
  };
}
