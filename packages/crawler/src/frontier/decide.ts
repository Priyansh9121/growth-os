/**
 * The enqueue decision — should this URL enter the frontier, and if not, why?
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Every rule that governs whether a discovered URL becomes work, in one pure
 * function with no I/O. The database-backed frontier applies it; this decides it.
 *
 * ⚠️ WHY IT IS PURE, AND SEPARATE
 * This is where six things compose — normalisation, scope, robots, depth, the
 * budget and the row ceiling — and composition is where the interesting bugs
 * are. A pure function can be tested exhaustively in microseconds against every
 * combination; the same logic embedded in a transaction can only be tested
 * against the combinations someone thought to seed a database for.
 *
 * ⚠️ ROBOTS IS CONSULTED HERE, BEFORE ENQUEUEING — NOT AFTER DEQUEUING.
 * A disallowed URL never becomes work. Checking after dequeue would mean the
 * frontier's depth counted toward a budget for URLs that were never going to be
 * fetched, and a crawl of a site that disallows most of itself would report
 * "500 pages queued, 12 fetched" with no way to see why.
 *
 * ⚠️ IT RECORDS THE DECIDING RULE, NEVER A JUDGEMENT (AGENTS.md §5).
 * `Disallow: /admin` is a fact from the operator's own file. "This site blocks
 * too much" is a finding and belongs to a later stage.
 *
 * @see docs/decisions/ADR-0036-frontier-budget-and-ceiling.md
 */

import type { SkipReason } from '@growth-os/contracts';
import { isAllowed, type RobotsRules } from '../robots/parse';
import { normaliseUrlOutcome } from '../urls/normalise';
import { classifyScope, type CrawlScope } from '../urls/scope';

/** How a URL came to our attention. Recorded so "why did you crawl that?" has an answer. */
export type DiscoverySource = 'seed' | 'link' | 'sitemap' | 'redirect';

export interface Candidate {
  /** As found — an href, a Location header, a sitemap <loc>. Never pre-normalised. */
  readonly url: string;
  /** Resolved against this, when the candidate is relative. */
  readonly base?: string;
  readonly depth: number;
  readonly source: DiscoverySource;
}

export interface FrontierBudget {
  /**
   * The number of pages that may be FETCHED.
   *
   * ⚠️ Fetched, not discovered (ADR-0036). Skipped and out-of-scope URLs are
   * recorded without consuming it: the limit is a promise about work done
   * against someone else's server, and skipping a URL costs that server
   * nothing.
   */
  readonly pageLimit: number;
  readonly maxDepth: number;
  /**
   * The ceiling on total frontier ROWS.
   *
   * Exists because `pageLimit` deliberately does not bound discovery, which
   * leaves the table unbounded: one page linking to ten thousand distinct
   * filtered URLs writes ten thousand skipped rows while fetching none. See
   * `frontierRowCeiling`.
   */
  readonly maxRows: number;
}

export interface FrontierCounts {
  /** Rows already in the frontier, in any state. */
  readonly rows: number;
  /** URLs already fetched or being fetched — what `pageLimit` bounds. */
  readonly fetchable: number;
}

export type EnqueueDecision =
  | {
      readonly accept: true;
      readonly normalisedUrl: string;
      readonly depth: number;
    }
  | {
      readonly accept: false;
      /** Null when the candidate was not a URL at all. */
      readonly normalisedUrl: string | null;
      readonly skipReason: SkipReason;
      /** The deciding robots line, verbatim, when robots decided. A fact. */
      readonly rule: string | null;
      /** True when nothing may be recorded either — the row ceiling is full. */
      readonly unrecordable: boolean;
    };

export interface DecideInput {
  readonly candidate: Candidate;
  readonly scope: CrawlScope;
  readonly robots: RobotsRules;
  /** When true, nothing on this site may be fetched (ADR-0035 fail-closed). */
  readonly siteDisallowed: boolean;
  readonly budget: FrontierBudget;
  readonly counts: FrontierCounts;
}

/**
 * Decide one candidate.
 *
 * ⚠️ THE ORDER OF THESE CHECKS IS THE DESIGN, not an accident of writing.
 *
 * Cheapest and most-definitive first: a `mailto:` is not a URL at all, so
 * asking robots about it is meaningless. Scope precedes robots because a
 * third party's URL is not ours to evaluate rules for — and asking would mean
 * fetching *their* robots.txt. The row ceiling is last, because it is the only
 * check whose answer is "we cannot even write down that we saw this".
 */
export function decideEnqueue(input: DecideInput): EnqueueDecision {
  const { candidate, scope, robots, budget, counts } = input;

  // 1. IDENTITY. One definition, never inlined (AGENTS.md §5).
  const identity = normaliseUrlOutcome(candidate.url, {
    ...(candidate.base ? { base: candidate.base } : {}),
  });

  if (identity.url === null) {
    // ⚠️ TWO REASONS, NOT ONE. Until ADR-0042 both were `unsupported_scheme`,
    // which said "this is a `mailto:`" about an ordinary page whose only
    // problem was length. The length ceiling is ours; the scheme is the site's.
    //
    // Recorded either way, so a link audit can still count what it saw.
    const reason: SkipReason =
      identity.refusal === 'too_long' ? 'url_too_long' : 'unsupported_scheme';
    return refuse(null, reason, null, counts, budget);
  }

  const normalisedUrl = identity.url;

  // 2. SCOPE. A reason, not a boolean, because the three ways of being out of
  //    scope are three different facts about a site.
  const verdict = classifyScope(normalisedUrl, scope);
  if (verdict === 'external') {
    return refuse(normalisedUrl, 'external', null, counts, budget);
  }
  if (verdict === 'other_subdomain') {
    return refuse(normalisedUrl, 'other_subdomain', null, counts, budget);
  }

  // 3. DEPTH, before robots: a URL too deep will not be fetched whatever
  //    robots says, and asking is work with no consequence.
  if (candidate.depth > budget.maxDepth) {
    return refuse(normalisedUrl, 'depth_limit', null, counts, budget);
  }

  // 4. ROBOTS. Consulted BEFORE the URL becomes work.
  if (input.siteDisallowed) {
    // The whole site is refused because robots.txt could not be read. The rule
    // is null on purpose — there is no line to quote, and quoting one the site
    // never wrote would be worse than saying nothing.
    return refuse(normalisedUrl, 'robots_disallowed', null, counts, budget);
  }

  const robotsVerdict = isAllowed(robots, normalisedUrl);
  if (!robotsVerdict.allowed) {
    // ⚠️ WHOSE DECISION WAS IT? `robots_disallowed` asserts that a rule the
    // site owner wrote refused this. When the matcher's step budget ran out we
    // never computed whether any rule matched — we refused rather than guess
    // (ADR-0039) — and saying otherwise attributes our limit to their file.
    // The verdict has carried the distinction since that ADR; the frontier row
    // could not express it until ADR-0042.
    const reason: SkipReason =
      robotsVerdict.reason === 'budget_exhausted' ? 'budget_exhausted' : 'robots_disallowed';
    return refuse(normalisedUrl, reason, robotsVerdict.rule, counts, budget);
  }

  // 5. BUDGET. Only reached by a URL that would actually be fetched, which is
  //    the whole point of reading `pageLimit` as a fetch budget.
  if (counts.fetchable >= budget.pageLimit) {
    return refuse(normalisedUrl, 'page_limit', null, counts, budget);
  }

  // 6. THE ROW CEILING, checked last. A URL that passes everything else and
  //    fails here is one we have no room to record at all.
  if (counts.rows >= budget.maxRows) {
    return {
      accept: false,
      normalisedUrl,
      skipReason: 'page_limit',
      rule: null,
      unrecordable: true,
    };
  }

  return { accept: true, normalisedUrl, depth: candidate.depth };
}

function refuse(
  normalisedUrl: string | null,
  skipReason: SkipReason,
  rule: string | null,
  counts: FrontierCounts,
  budget: FrontierBudget,
): EnqueueDecision {
  return {
    accept: false,
    normalisedUrl,
    skipReason,
    rule,
    // ⚠️ Even a refusal needs a row to be recorded in, and rows are finite.
    // Past the ceiling the honest report is "discovery was truncated", not a
    // silently shorter list.
    unrecordable: counts.rows >= budget.maxRows,
  };
}

// ---------------------------------------------------------------------------
// The row ceiling
// ---------------------------------------------------------------------------

/** Never fewer than this, however small `pageLimit` is. */
export const FRONTIER_ROWS_FLOOR = 500;
/** Never more than this, however large `pageLimit` is. */
export const FRONTIER_ROWS_CAP = 20_000;
/** Rows permitted per unit of page budget. */
export const FRONTIER_ROWS_PER_PAGE = 10;

/**
 * How many frontier rows one crawl may write.
 *
 * ⚠️ THIS EXISTS BECAUSE `pageLimit` DELIBERATELY DOES NOT BOUND DISCOVERY.
 *
 * Reading `pageLimit` as a fetch budget (ADR-0036) is right for the operator —
 * a site with 400 external links should not get a fifth of the crawl it
 * configured — and it leaves the frontier table unbounded. One page linking to
 * ten thousand distinct filtered URLs writes ten thousand skipped rows while
 * fetching nothing, and a crawl configured for 50 pages exhausts storage.
 *
 * So there is a second, higher limit. The shape:
 *
 *   `clamp(pageLimit × 10, 500, 20000)`
 *
 * **Why a multiple rather than a flat number.** It scales with what the operator
 * asked for. A 50-page crawl of a microsite and a 10,000-page crawl of a
 * retailer are not the same amount of legitimate discovery, and one number for
 * both is either uselessly loose or wrong for the small case.
 *
 * **Why ten.** A real business site discovers roughly two distinct URLs per page
 * fetched once navigation is deduplicated — internal pages, plus external links
 * that repeat heavily. Ten leaves a five-fold margin over that, which covers
 * faceted navigation and pagination without covering a generator.
 *
 * **Why a floor of 500.** At `pageLimit = 10` a multiple gives 100, and a single
 * link-heavy page can legitimately exceed that. The floor makes small crawls
 * behave.
 *
 * **Why a cap of 20,000.** Storage. A frontier row is a URL plus small columns
 * — a few hundred bytes — so 20,000 rows is single-digit megabytes per crawl.
 * Crawl history is retained deliberately and has no decided retention rule yet
 * ([ADR-0034](../decisions/ADR-0034-crawl-storage-model.md)), so per-crawl cost
 * multiplies by every crawl ever run. An uncapped multiple at
 * `pageLimit = 10000` would be 100,000 rows per crawl, and a hundred crawls of
 * one site becomes a storage conversation nobody chose to have.
 *
 * ⚠️ Hitting this ceiling is NOT a correctness failure once `pageLimit` is
 * already binding: if 5,000 URLs are known and only 500 may be fetched, the
 * 5,001st discovery changes nothing that will happen. What it does cost is
 * honesty — the crawl no longer knows the true discovered total — which is why
 * truncation is reported rather than silent.
 */
export function frontierRowCeiling(pageLimit: number): number {
  const scaled = pageLimit * FRONTIER_ROWS_PER_PAGE;
  return Math.min(FRONTIER_ROWS_CAP, Math.max(FRONTIER_ROWS_FLOOR, scaled));
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/**
 * Why a crawl loop stopped.
 *
 * ⚠️ `depth_exhausted` IS DISTINGUISHABLE FROM `frontier_empty`, and modelling
 * them as one would lose a real fact.
 *
 * Depth never terminates a loop directly — a too-deep URL is refused at
 * enqueue, so the loop ends by running out of work. But "we stopped because the
 * site is deeper than you allowed" and "we stopped because we had seen
 * everything" are different answers for an operator, and only the first is a
 * reason to raise a setting.
 */
export type TerminationReason =
  'budget_exhausted' | 'depth_exhausted' | 'frontier_empty' | 'cancelled';

export interface TerminationInput {
  readonly cancelRequested: boolean;
  readonly queued: number;
  readonly fetchable: number;
  readonly pageLimit: number;
  /** True when at least one URL was refused for depth during this crawl. */
  readonly skippedForDepth: boolean;
}

/**
 * Should the loop continue, and if not, why did it stop?
 *
 * ⚠️ CANCELLATION IS CHECKED FIRST. A cancelled crawl that also happened to
 * exhaust its budget is cancelled — that is what the operator did, and
 * reporting "completed" because the arithmetic also worked out would be a lie
 * about who decided.
 */
export function terminationReason(input: TerminationInput): TerminationReason | null {
  if (input.cancelRequested) return 'cancelled';
  if (input.fetchable >= input.pageLimit) return 'budget_exhausted';
  if (input.queued === 0) return input.skippedForDepth ? 'depth_exhausted' : 'frontier_empty';
  return null;
}
