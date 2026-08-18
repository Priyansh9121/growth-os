/**
 * URL normalisation — the one definition of crawl identity.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Answer "are these two URLs the same page?" once, for everybody.
 *
 * ⚠️ WHY THIS BEING SHARED IS THE WHOLE POINT
 * Five parts of a crawler independently form an opinion about a URL: the
 * frontier deduplicating, a link extracted from an anchor, a `<link rel=canonical>`,
 * a redirect target, and a sitemap entry. If each normalises differently, the
 * crawler fetches `/about` and `/about/` as two pages, reports 428 pages for a
 * 214-page site, and every downstream count is wrong in a way nobody can trace.
 *
 * So there is exactly one function, and everything calls it.
 *
 * ⚠️ NORMALISATION IS NOT SANITISATION
 * This decides IDENTITY. Whether a URL may be fetched at all is
 * `@growth-os/net`'s `admitUrl`, and whether it is in scope is `scope.ts`.
 * Three questions, three functions — conflating them is how a URL ends up
 * fetched because it normalised cleanly.
 *
 * @see docs/decisions/ADR-0033-url-normalisation.md
 * @see docs/decisions/ADR-0038-url-length-ceiling.md
 */

import { MAX_URL_LENGTH } from '@growth-os/net';

/**
 * Acquisition-only parameters, stripped for identity.
 *
 * `example.test/pricing?utm_source=google` and `example.test/pricing` are the
 * same page. Keeping them apart would let one campaign link inflate a site's
 * page count and would waste the crawl budget re-fetching identical HTML.
 *
 * ⚠️ THE SAME NAMES ARE MEANINGFUL ELSEWHERE. Stage 3's attribution reads
 * exactly these parameters to decide where a lead came from
 * ([ADR-0028](../decisions/ADR-0028-attribution-storage.md)). Discarding them
 * here is a statement about page identity, not about their value.
 */
const TRACKING_PARAMETERS: readonly string[] = [
  // Campaign
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic',
  // Ad-platform click identifiers
  'gclid',
  'gclsrc',
  'gbraid',
  'wbraid',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  // Email and analytics vendors
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'hsa_acc',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
  'vero_id',
  'vero_conv',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'ck_subscriber_id',
  's_kwcid',
  'ef_id',
  'yclid',
  // Referral decoration
  'ref',
  'referrer',
  'source',
];

const TRACKING_SET = new Set(TRACKING_PARAMETERS);

/**
 * Session-shaped parameters, stripped for identity.
 *
 * A session id in a URL creates a NEW url for every visitor, so a crawler that
 * kept them would treat one page as infinitely many and exhaust its budget on a
 * single template. Stripped rather than refused, because — unlike the
 * credential-shaped parameters `@growth-os/net` refuses outright — these are
 * usually a CMS decorating its own links rather than a secret.
 */
const SESSION_PARAMETERS: readonly string[] = [
  'phpsessid',
  'jsessionid',
  'aspsessionid',
  'sessionid',
  'sid',
  'cfid',
  'cftoken',
  'zenid',
  '_ga',
  '_gl',
];

const SESSION_SET = new Set(SESSION_PARAMETERS);

export interface NormaliseOptions {
  /**
   * Resolve a relative URL against this absolute one.
   *
   * Supplied whenever a URL came out of a document — an anchor, a canonical
   * tag, a `Location` header — because `href="/about"` means nothing on its own.
   */
  readonly base?: string;
  /**
   * Treat `/path` and `/path/` as the same page.
   *
   * Default `false`, deliberately: they ARE different URLs, servers routinely
   * serve different content, and folding them would report a redirect chain
   * that does not exist. A site that canonicalises one to the other produces a
   * 301, which the crawler follows and records — the honest way to learn it.
   */
  readonly foldTrailingSlash?: boolean;
}

/**
 * Reduce a URL to its crawl identity, or `null` if it is not one.
 *
 * `null` means "not a crawlable resource" — a `mailto:`, a `javascript:`, an
 * anchor-only `#section`, an unparseable string, or one longer than
 * `MAX_URL_LENGTH`. Never a repaired guess: a half-parsed URL that "looks
 * close" enqueues the wrong page, which is worse than enqueueing none.
 */
export function normaliseUrl(input: string, options: NormaliseOptions = {}): string | null {
  const raw = input.trim();
  if (raw.length === 0) return null;

  // ⚠️ THE CEILING IS CHECKED BEFORE ANY WORK, AND AGAIN AFTER.
  //
  // Before, because the cost is incurred PRODUCING the identity, not holding
  // it: percent-decoding and query rebuilding are linear in input, and the
  // robots matcher downstream is O(rules × pattern × target). Capping only the
  // result would leave every one of those bills already paid. Measured: a
  // hostile robots.txt against a 10,000-character path blocked the event loop
  // for 16.8 s; at this ceiling the same corpus costs 63 ms.
  //
  // `MAX_URL_LENGTH` is imported, never redeclared. `admitUrl` enforces the
  // same number at fetch time, and a frontier row the fetcher will always
  // refuse is a row that can only ever fail (ADR-0038).
  if (raw.length > MAX_URL_LENGTH) return null;

  // ⚠️ A FRAGMENT-ONLY HREF IS THE CURRENT PAGE, NOT A NEW ONE.
  // `<a href="#main">Skip to content</a>` appears on every accessible site on
  // the internet. Enqueueing it would add one self-referential URL per page.
  if (raw.startsWith('#')) return null;

  let url: URL;
  try {
    url = options.base ? new URL(raw, options.base) : new URL(raw);
  } catch {
    return null;
  }

  // Only web pages have crawl identity. `mailto:`, `tel:`, `javascript:`,
  // `data:` are recorded as links elsewhere and are not resources.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;

  // -- Host -----------------------------------------------------------------
  // The parser lowercases and punycodes already; the trailing root-zone dot is
  // ours to remove. `example.com.` and `example.com` are one site, and DNS
  // resolves both — leaving the dot in makes them two rows.
  let host = url.hostname;
  if (host.endsWith('.') && !host.endsWith('..')) host = host.slice(0, -1);

  // -- Port -----------------------------------------------------------------
  // A default port made explicit is the same resource. `:80` on http and `:443`
  // on https are dropped; anything else is part of identity.
  const isDefaultPort =
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443');
  const port = url.port === '' || isDefaultPort ? '' : `:${url.port}`;

  // -- Path -----------------------------------------------------------------
  // `URL` has already resolved `.` and `..` segments and percent-encoded what
  // needed encoding. What it does NOT do is decide about the empty path.
  let path = url.pathname === '' ? '/' : url.pathname;
  if (options.foldTrailingSlash && path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  path = normalisePercentEncoding(path);

  // -- Query ----------------------------------------------------------------
  const query = normaliseQuery(url.searchParams);

  // -- Fragment -------------------------------------------------------------
  // ⚠️ ALWAYS DROPPED. `/page#one` and `/page#two` are ONE HTTP resource: the
  // fragment never leaves the browser. A crawler that kept it would fetch the
  // same bytes once per heading on a page with a table of contents.

  const normalised = `${url.protocol}//${host}${port}${path}${query}`;

  // ⚠️ AND AGAIN, BECAUSE NORMALISING CAN GROW A URL.
  //
  // `+` becomes `%20` in the query — measured at 2.98× on a query of plus
  // signs, so a 1,018-character input yields 3,018 characters of identity. The
  // input check cannot see that, and this string is what gets stored.
  //
  // `crawl_pages` and `site_pages` carry CHECK length(…) <= 2048;
  // `crawl_frontier` does NOT, so on the enqueue path this check is the only
  // thing keeping the stored identity inside the ceiling (ADR-0038).
  //
  // A relative href resolved against a long base reaches here the same way.
  if (normalised.length > MAX_URL_LENGTH) return null;

  return normalised;
}

/**
 * Rebuild the query string as an identity.
 *
 * Three transformations, each with a reason:
 *
 *  1. **Tracking and session parameters are removed** — see the tables above.
 *  2. **Remaining parameters are sorted by name** — `?a=1&b=2` and `?b=2&a=1`
 *     are the same request to every server ever written, and treating them as
 *     two pages doubles a faceted-navigation crawl.
 *  3. **Repeated names keep their relative order** — `?tag=a&tag=b` is not
 *     `?tag=b&tag=a` to a server that reads the first occurrence.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT DONE: stripping every query parameter.
 * It is tempting, it collapses infinite query spaces instantly, and it is
 * wrong — `?product=1234` is a different product. Query explosion is bounded by
 * the frontier's caps, not by pretending pages are the same.
 */
function normaliseQuery(params: URLSearchParams): string {
  const kept: [string, string][] = [];

  for (const [name, value] of params) {
    const lower = name.toLowerCase();
    if (TRACKING_SET.has(lower) || SESSION_SET.has(lower)) continue;
    kept.push([name, value]);
  }

  if (kept.length === 0) return '';

  // A stable sort on the NAME only, so repeated names keep their document
  // order relative to each other.
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const rebuilt = new URLSearchParams();
  for (const [name, value] of kept) rebuilt.append(name, value);

  // `URLSearchParams` encodes a space as `+`; `%20` is what appears in a path
  // and in most real links. Either is correct; consistency is what matters,
  // because inconsistency is a duplicate row.
  return `?${rebuilt.toString().replace(/\+/g, '%20')}`;
}

/**
 * Canonicalise percent-encoding in a path.
 *
 * `%2F` and `%2f` are the same byte; `%7E` and `~` are the same character.
 * Uppercase the hex digits (RFC 3986 §6.2.2.1) and decode the unreserved set,
 * so one page cannot arrive under four spellings.
 */
function normalisePercentEncoding(path: string): string {
  return path.replace(/%[0-9a-fA-F]{2}/g, (escape) => {
    const code = Number.parseInt(escape.slice(1), 16);
    const character = String.fromCharCode(code);
    // Unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~"
    if (/[A-Za-z0-9\-._~]/.test(character)) return character;
    return escape.toUpperCase();
  });
}

/** The parameter names stripped for identity, for documentation and tests. */
export const STRIPPED_PARAMETERS = {
  tracking: TRACKING_PARAMETERS,
  session: SESSION_PARAMETERS,
} as const;

/**
 * A URL's depth from the site root, counted in path segments.
 *
 * `/` is 0, `/about` is 1, `/blog/2026/post` is 3. Used to stop a crawler
 * walking a pathological navigation pattern — a calendar with a "next month"
 * link generates an unbounded chain of pages that are each one level deeper and
 * all equally worthless.
 */
export function urlDepth(normalisedUrl: string): number {
  try {
    const { pathname } = new URL(normalisedUrl);
    return pathname.split('/').filter((segment) => segment.length > 0).length;
  } catch {
    return 0;
  }
}
