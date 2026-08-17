/**
 * Fetching robots.txt, and deciding what its absence means.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn an HTTP outcome into a permission state. The parser answers "what does
 * this file say"; this answers "what may we do when we could not read it".
 *
 * ⚠️ THE FAIL-CLOSED RULE, AND WHY IT IS NOT PARANOIA
 *
 * A `5xx` or a network failure **disallows the entire site**. Not "proceed
 * unrestricted", which is the tempting reading of "there are no rules".
 *
 * The reasoning is about *when* the failure happens. A server returning 500 or
 * refusing connections is a server under load, misconfigured, or mid-deploy —
 * which is the exact moment a crawler causes the most harm by continuing. The
 * behaviour that treats a 5xx as permission is the behaviour that hits a
 * struggling site with five hundred requests.
 *
 * And it is not evidence either way: **"we could not read robots.txt" is not
 * "robots.txt permits this"**. Inferring permission from our own failure to ask
 * is the same error as inferring consent from silence.
 *
 * A `4xx` is different, and is treated as unrestricted. A 404 is a definite
 * answer from a working server: there is no file. RFC 9309 §2.3.1.3 says
 * unavailable-means-allowed for 4xx, and site owners rely on it — most sites
 * have no robots.txt at all.
 *
 * @see docs/decisions/ADR-0035-robots-and-politeness.md
 */

import { safeFetch, type SafeFetchDependencies } from '@growth-os/net';
import {
  ALLOW_ALL,
  DEFAULT_ROBOTS_LIMITS,
  parseRobotsTxt,
  USER_AGENT_STRING,
  type RobotsLimits,
  type RobotsRules,
} from './parse';

/**
 * What a robots.txt fetch established.
 *
 * Mirrors `ROBOTS_OUTCOMES` in `@growth-os/contracts`, which is what a crawl
 * row records. Every crawl stores this, because "we crawled 400 pages" means
 * something different when the rules were read than when they were not.
 */
export type RobotsFetchOutcome = 'fetched' | 'absent' | 'forbidden' | 'unavailable' | 'error';

export interface RobotsState {
  readonly outcome: RobotsFetchOutcome;
  readonly rules: RobotsRules;
  /**
   * ⚠️ WHEN TRUE, NOTHING ON THIS SITE MAY BE FETCHED, whatever `rules` says.
   *
   * A separate flag rather than a synthetic `Disallow: /` rule, so an operator
   * is told "we could not read your robots.txt" instead of being shown a rule
   * their file does not contain.
   */
  readonly siteDisallowed: boolean;
  /** Safe to show an operator. Never a stack trace, never a full URL. */
  readonly detail: string;
  /** Where it was fetched from. Recorded so the crawl is reproducible. */
  readonly url: string;
}

/**
 * `403` is treated as fail-closed, with `401`.
 *
 * A server that authenticates its robots.txt is telling us we are not an
 * audience for its rules. Proceeding unrestricted against a site that has
 * deliberately walled off the file is the least defensible reading available.
 */
const FAIL_CLOSED_STATUSES = new Set([401, 403]);

export interface FetchRobotsOptions {
  readonly limits?: RobotsLimits;
  /**
   * The TRANSFER ceiling — bytes accepted from the network before the fetch is
   * refused outright.
   *
   * ⚠️ DELIBERATELY DIFFERENT FROM THE PARSE CAP, and the difference is a
   * policy decision rather than an oversight.
   *
   * `limits.maxBytes` (512 KB) is how much we PARSE; beyond it the file is
   * truncated and the rules we read still apply. That matches what every major
   * crawler does, and a site with a 600 KB robots.txt is unusual, not hostile.
   * Failing closed on it would make a large site uncrawlable over a file we
   * could have read most of.
   *
   * This ceiling is four times larger and catches something else: a body big
   * enough to be an attack on our memory rather than a verbose file. Crossing
   * it IS fail-closed, because at that point we have learned nothing about the
   * rules and the server is behaving abnormally.
   */
  readonly maxBytes?: number;
}

/** 2 MB. Four times the parse cap — see `maxBytes` above. */
const DEFAULT_TRANSFER_CEILING = 2 * 1024 * 1024;

/**
 * Fetch and interpret `/robots.txt` for an origin.
 *
 * ⚠️ THROUGH `safeFetch`, LIKE EVERYTHING ELSE (AGENTS.md §5). This is the
 * first request a crawl makes, to an address a customer supplied, which makes
 * it precisely the wrong place for a convenience client.
 */
export async function fetchRobots(
  network: SafeFetchDependencies,
  origin: string,
  options: FetchRobotsOptions = {},
): Promise<RobotsState> {
  const limits = options.limits ?? DEFAULT_ROBOTS_LIMITS;
  const transferCeiling = options.maxBytes ?? DEFAULT_TRANSFER_CEILING;
  const url = `${origin.replace(/\/$/, '')}/robots.txt`;

  const outcome = await safeFetch(network, url, {
    headers: { 'user-agent': USER_AGENT_STRING, accept: 'text/plain,*/*;q=0.8' },
    // Deliberately NOT constrained by content type. Real servers serve
    // robots.txt as text/html, application/octet-stream and worse; refusing on
    // the header would fail closed against sites whose rules we can read
    // perfectly well.
    limits: {
      maxCompressedBytes: transferCeiling,
      maxDecompressedBytes: transferCeiling * 4,
      maxRedirects: 5,
    },
  });

  if (!outcome.ok) {
    // ⚠️ EVERY NETWORK-LEVEL FAILURE IS FAIL-CLOSED, including the SSRF
    // refusal. A site whose robots.txt resolves to a private address is not a
    // site we should be crawling the rest of.
    return {
      outcome: 'error',
      rules: ALLOW_ALL,
      siteDisallowed: true,
      detail: `Could not read robots.txt (${outcome.failure}). Nothing on this site will be crawled until it can be read.`,
      url,
    };
  }

  const status = outcome.status;

  if (status >= 200 && status < 300) {
    const rules = parseRobotsTxt(outcome.body.toString('utf8'), limits);
    return {
      outcome: 'fetched',
      rules,
      siteDisallowed: false,
      detail: rules.truncated
        ? 'robots.txt was larger than we parse; the rules we read are applied.'
        : 'robots.txt read.',
      url,
    };
  }

  if (FAIL_CLOSED_STATUSES.has(status)) {
    return {
      outcome: 'forbidden',
      rules: ALLOW_ALL,
      siteDisallowed: true,
      detail: `robots.txt returned ${status}. A site that authenticates its rules is not one we crawl.`,
      url,
    };
  }

  if (status >= 400 && status < 500) {
    // The definite answer: there is no file. Most sites are here.
    return {
      outcome: 'absent',
      rules: ALLOW_ALL,
      siteDisallowed: false,
      detail: `No robots.txt (${status}). Crawling is unrestricted.`,
      url,
    };
  }

  // 5xx, and anything else a server invents.
  return {
    outcome: 'unavailable',
    rules: ALLOW_ALL,
    siteDisallowed: true,
    detail: `robots.txt returned ${status}. Nothing on this site will be crawled until it can be read.`,
    url,
  };
}

/**
 * ⚠️ RECOVERY IS PER CRAWL, AND IT IS DELIBERATE RATHER THAN ACCIDENTAL.
 *
 * `robots.txt` is fetched **once per crawl**, at the start, and cached for that
 * crawl's lifetime. So a site that 500s recovers on the *next* crawl and not
 * during the current one. There is no cooldown, no retry loop, and no
 * revalidation partway through.
 *
 * That combination is a decision, not an omission, and it is the part a future
 * contributor would otherwise implement by accident:
 *
 *  - **No mid-crawl retry.** A crawl whose permission state changed halfway
 *    would have fetched some pages under one rule set and some under another,
 *    and no honest way to report which.
 *  - **No cooldown before the next crawl.** The next crawl is a fresh request
 *    on a human timescale — minutes or days later — so a recovered server is
 *    read normally. A cooldown would add a second timer whose only effect is to
 *    keep punishing a site that has already recovered.
 *  - **Cached for the crawl.** Fetching robots.txt per page would multiply our
 *    request count against the one file we are consulting out of politeness.
 *
 * This function exists so the rule has a name and a place to be tested.
 */
export function robotsCacheScope(): 'per_crawl' {
  return 'per_crawl';
}
