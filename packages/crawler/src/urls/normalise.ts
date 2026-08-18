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
 * Why a URL has no crawl identity.
 *
 * ⚠️ TWO REFUSALS, BECAUSE THEY ARE DIFFERENT FACTS ABOUT A SITE.
 * A `mailto:` is not a page and never will be. A URL over the ceiling **is** a
 * page — an ordinary one — that this crawler will not carry. Collapsing them
 * meant the frontier recorded `unsupported_scheme` for a URL with a perfectly
 * good scheme, which is a wrong fact and not merely a vague one (ADR-0042).
 */
export type NormaliseRefusal = 'not_a_resource' | 'too_long';

export interface NormaliseOutcome {
  /** The crawl identity, or `null` when there is none. */
  readonly url: string | null;
  /** Why there is none. `null` exactly when `url` is not. */
  readonly refusal: NormaliseRefusal | null;
}

const NOT_A_RESOURCE: NormaliseOutcome = { url: null, refusal: 'not_a_resource' };
const TOO_LONG: NormaliseOutcome = { url: null, refusal: 'too_long' };

/**
 * Reduce a URL to its crawl identity, and say why when there is none.
 *
 * ⚠️ THIS IS THE ONLY IMPLEMENTATION. `normaliseUrl` below is a one-line
 * wrapper over it, so the two can never disagree about what "the same page"
 * means — §5 makes URL identity singular, and two normalisers that drift is
 * exactly the failure that invariant exists to prevent. Callers that do not
 * need the reason should keep using `normaliseUrl`.
 *
 * Never a repaired guess: a half-parsed URL that "looks close" enqueues the
 * wrong page, which is worse than enqueueing none.
 */
export function normaliseUrlOutcome(
  input: string,
  options: NormaliseOptions = {},
): NormaliseOutcome {
  const raw = input.trim();
  if (raw.length === 0) return NOT_A_RESOURCE;

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
  if (raw.length > MAX_URL_LENGTH) return TOO_LONG;

  // ⚠️ A FRAGMENT-ONLY HREF IS THE CURRENT PAGE, NOT A NEW ONE.
  // `<a href="#main">Skip to content</a>` appears on every accessible site on
  // the internet. Enqueueing it would add one self-referential URL per page.
  if (raw.startsWith('#')) return NOT_A_RESOURCE;

  let url: URL;
  try {
    url = options.base ? new URL(raw, options.base) : new URL(raw);
  } catch {
    return NOT_A_RESOURCE;
  }

  // Only web pages have crawl identity. `mailto:`, `tel:`, `javascript:`,
  // `data:` are recorded as links elsewhere and are not resources.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return NOT_A_RESOURCE;
  if (url.hostname.length === 0) return NOT_A_RESOURCE;

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
  // ⚠️ `url.search`, THE RAW STRING — NOT `url.searchParams`.
  //
  // Reading `searchParams` decodes each value into a JS string, and a byte that
  // is not valid UTF-8 has no character to decode to, so it becomes U+FFFD and
  // re-encodes as `%EF%BF%BD`. That is lossy and irreversible, and it is why
  // this argument is a string. See `normaliseQuery`.
  const query = normaliseQuery(url.search);

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
  if (normalised.length > MAX_URL_LENGTH) return TOO_LONG;

  return { url: normalised, refusal: null };
}

/**
 * Reduce a URL to its crawl identity, or `null` if it is not one.
 *
 * `null` means "not a crawlable resource" — a `mailto:`, a `javascript:`, an
 * anchor-only `#section`, an unparseable string, or one longer than
 * `MAX_URL_LENGTH`. Use `normaliseUrlOutcome` when which of those it was
 * matters; it is the same code path.
 */
export function normaliseUrl(input: string, options: NormaliseOptions = {}): string | null {
  return normaliseUrlOutcome(input, options).url;
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
 *
 * ⚠️ AND IT TAKES THE RAW SEARCH STRING, WHICH IS THE WHOLE POINT.
 *
 * This used to take a `URLSearchParams` and rebuild it. Iterating one decodes
 * every value into a JS string, and **a byte that is not valid UTF-8 has no
 * character to decode to** — it becomes U+FFFD, which re-encodes as
 * `%EF%BF%BD`. The original byte is gone.
 *
 * Measured (dev log 0018, ADR-0041): on a legacy Latin-1 site, `?q=Fran%E7ois`,
 * `?q=Fran%E8ois` and `?q=Fran%E9ois` became **one** identity. All 128 bytes
 * from 0x80 to 0xFF shared it. The same bytes in the *path* survived untouched,
 * so the two halves of one URL were normalised under incompatible rules.
 *
 * That is not a cosmetic fold. `frontier.ts` stores only the normalised form and
 * discards the original, so the crawler **fetches a URL the site never linked**,
 * and the string keys the durable `site_pages(site_id, normalised_url)` index —
 * permanent across crawls (AGENTS.md §5, horizon #1).
 *
 * So the query is treated as what it is on the wire: octets. Splitting on `&`
 * and `=` needs no decoding, and `normalisePercentEncoding` canonicalises the
 * escapes **without decoding anything outside the unreserved set** — a set that
 * contains no delimiter, so it can never manufacture a `&` or an `=`.
 */
function normaliseQuery(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw.length === 0) return '';

  const kept: [name: string, value: string][] = [];

  for (const pair of raw.split('&')) {
    // `?a=1&&b=2` and a trailing `&` produce empty pairs, which are not
    // parameters. `URLSearchParams` ignored them and so does this.
    if (pair.length === 0) continue;

    // The FIRST `=` separates; any later one is part of the value, because
    // `?q=a=b` is a single parameter whose value contains an equals sign.
    const equals = pair.indexOf('=');
    const name = normaliseQueryOctets(equals === -1 ? pair : pair.slice(0, equals));
    const value = normaliseQueryOctets(equals === -1 ? '' : pair.slice(equals + 1));

    // ⚠️ MATCHED CASE-INSENSITIVELY, DELIBERATELY, AND THE REASON IS PHPSESSID.
    // PHP's cookieless session parameter is literally `PHPSESSID` — uppercase —
    // and `JSESSIONID`, `CFID` and `CFTOKEN` are the same. Matching the case a
    // site actually writes would stop stripping them, and an unstripped session
    // id is a new identity per visitor: unbounded, and strictly worse than the
    // false strip it would prevent. ADR-0041 records the measurement.
    const lower = name.toLowerCase();
    if (TRACKING_SET.has(lower) || SESSION_SET.has(lower)) continue;

    kept.push([name, value]);
  }

  if (kept.length === 0) return '';

  // A stable sort on the NAME only, so repeated names keep their document
  // order relative to each other.
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // `name=value` even where the input wrote a bare `name`, because `?q` and
  // `?q=` are the same empty value to every server, and this is the spelling
  // the previous implementation produced.
  return `?${kept.map(([name, value]) => `${name}=${value}`).join('&')}`;
}

/**
 * Canonicalise one query name or value without decoding its bytes.
 *
 * `+` is a space in a query, which is the one substitution that must happen
 * before anything else — `%20` is the spelling used here and in the path, and
 * inconsistency between them is a duplicate row.
 */
function normaliseQueryOctets(component: string): string {
  return normalisePercentEncoding(component.split('+').join('%20'));
}

/**
 * Canonicalise percent-encoding in a path or a query component.
 *
 * `%2F` and `%2f` are the same byte; `%7E` and `~` are the same character.
 * Uppercase the hex digits (RFC 3986 §6.2.2.1) and decode the unreserved set,
 * so one page cannot arrive under four spellings.
 *
 * ⚠️ IT DECODES THE UNRESERVED SET AND NOTHING ELSE, which is what makes it
 * safe on a query. That set is ALPHA / DIGIT / `-` / `.` / `_` / `~` and
 * contains **no delimiter**, so decoding can never manufacture a `&`, `=`, `?`,
 * `#` or `/` and turn one parameter into two. A byte outside it — `%E9`, `%C0`,
 * a lone surrogate half — is left exactly as the site wrote it.
 *
 * A `%` not followed by two hex digits is not an escape and is not touched.
 * `?q=%ZZ` and `?q=%25ZZ` are different URLs and stay different.
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
