/**
 * Crawl enumerations.
 *
 * ⚠️ THE LINE THIS FILE DEFENDS: STAGE 4 STORES FACTS, STAGE 5 PRODUCES
 * FINDINGS.
 *
 * A fact is `title_length = 0`, `http_status = 404`, `h1_count = 3`. A finding
 * is "Missing title · severity high · rewrite it as …". Nothing in this file
 * carries a severity, a score, or a recommendation, and nothing should be added
 * that does — the moment a crawler starts grading what it fetched, the grading
 * rule is buried in the collection code and cannot be changed without
 * recrawling.
 *
 * Stage 5 reads these facts and produces findings from them, which is what
 * makes "we changed our mind about severity" a re-evaluation rather than a
 * re-crawl of every customer's website.
 *
 * @see docs/decisions/ADR-0034-crawl-storage-model.md
 */

// ---------------------------------------------------------------------------
// Crawl runs
// ---------------------------------------------------------------------------

/**
 * A crawl's lifecycle.
 *
 * `queued` is the default, so a crawl row that exists but was never picked up
 * reads as waiting rather than as finished-with-nothing.
 */
export const CRAWL_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type CrawlStatus = (typeof CRAWL_STATUSES)[number];

export const CRAWL_STATUS_LABELS: Readonly<Record<CrawlStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Why a crawl started.
 *
 * ⚠️ `manual` carries a real user id; `scheduled` and `recrawl` do not, and
 * must not be given a fabricated one (ADR-0025). "Who started this crawl?" has
 * two honest answers — a person, or the system — and inventing a person for the
 * second is how an audit trail stops meaning anything.
 */
export const CRAWL_TRIGGERS = ['manual', 'scheduled', 'recrawl'] as const;
export type CrawlTrigger = (typeof CRAWL_TRIGGERS)[number];

export const CRAWL_TRIGGER_LABELS: Readonly<Record<CrawlTrigger, string>> = {
  manual: 'Started by a person',
  scheduled: 'Scheduled',
  recrawl: 'Recrawl',
};

/**
 * What happened when we asked for `/robots.txt`.
 *
 * ⚠️ EVERY ONE OF THESE IS RECORDED, because the crawl's meaning depends on it.
 * "We crawled 400 pages" means something different when robots.txt timed out
 * and we proceeded under a fail-open rule than when it was fetched and empty.
 * An operator who cannot tell those apart cannot trust either number.
 */
export const ROBOTS_OUTCOMES = [
  /** 2xx, parsed. Rules apply. */
  'fetched',
  /** 404 or 410. RFC 9309: absent means everything is allowed. */
  'absent',
  /** 401 or 403. The site is telling us we may not read its rules. */
  'forbidden',
  /** 429 or 5xx. Transient; we do not know the rules. */
  'unavailable',
  /** Timed out, DNS failure, TLS failure. */
  'error',
] as const;
export type RobotsOutcome = (typeof ROBOTS_OUTCOMES)[number];

export const ROBOTS_OUTCOME_LABELS: Readonly<Record<RobotsOutcome, string>> = {
  fetched: 'robots.txt read',
  absent: 'No robots.txt',
  forbidden: 'robots.txt access denied',
  unavailable: 'robots.txt unavailable',
  error: 'robots.txt could not be reached',
};

export const SITEMAP_OUTCOMES = [
  'fetched',
  'absent',
  'error',
  /** Found, but bigger than we will ingest. Recorded rather than silently cut. */
  'truncated',
  /** Not looked for, because robots.txt was unreadable. */
  'skipped',
] as const;
export type SitemapOutcome = (typeof SITEMAP_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Frontier
// ---------------------------------------------------------------------------

/**
 * A URL's state within one crawl.
 *
 * ⚠️ THIS LIVES IN THE DATABASE, NOT IN A `Set` IN MEMORY.
 * A worker that dies mid-crawl must not forget what it had already discovered:
 * the alternative is a restart that re-fetches every page a customer's server
 * already served, which is both slower and ruder.
 */
export const FRONTIER_STATES = [
  /** Found, not yet scheduled. */
  'discovered',
  /** Eligible to be claimed by a page worker. */
  'queued',
  /** Claimed. A stalled one returns to `queued`. */
  'fetching',
  /** Done — successfully or not. `crawl_pages` holds the outcome. */
  'fetched',
  /** Deliberately not fetched. `skip_reason` says why. */
  'skipped',
  /** Attempted and failed past its retry ceiling. */
  'failed',
] as const;
export type FrontierState = (typeof FRONTIER_STATES)[number];

/**
 * Why a discovered URL was not fetched.
 *
 * ⚠️ A SKIPPED URL IS STILL RECORDED. "We found 900 URLs and fetched 500" is a
 * different fact from "the site has 500 pages", and a crawler that silently
 * dropped the other 400 would report the second while meaning the first.
 */
export const SKIP_REASONS = [
  'robots_disallowed',
  'out_of_scope',
  'external',
  'other_subdomain',
  'page_limit',
  'depth_limit',
  'sensitive_url',
  'unsupported_scheme',
  'cancelled',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_LABELS: Readonly<Record<SkipReason, string>> = {
  robots_disallowed: 'Blocked by robots.txt',
  out_of_scope: 'Outside this site',
  external: 'External link',
  other_subdomain: 'On a subdomain you have not verified',
  page_limit: 'Page limit reached',
  depth_limit: 'Too deep',
  sensitive_url: 'URL looked like a private link',
  unsupported_scheme: 'Not a web page',
  cancelled: 'Crawl cancelled',
};

// ---------------------------------------------------------------------------
// Page outcomes
// ---------------------------------------------------------------------------

/**
 * How a single page fetch resolved.
 *
 * A CLOSED SET, and deliberately not a raw error string. These are counted,
 * grouped and shown to an operator; "Error: connect ETIMEDOUT 93.184.216.34:443"
 * is neither countable nor something a customer should be shown.
 */
export const PAGE_FETCH_OUTCOMES = [
  /** 2xx, HTML, parsed. */
  'fetched',
  /** 304 — unchanged since the last crawl; facts carried forward. */
  'unchanged',
  /** 3xx recorded; the target is a separate frontier entry. */
  'redirected',
  'http_4xx',
  'http_5xx',
  /** Refused before a socket opened, or by response policy. */
  'blocked',
  'failed',
] as const;
export type PageFetchOutcome = (typeof PAGE_FETCH_OUTCOMES)[number];

/**
 * Typed failure categories.
 *
 * ⚠️ MIRRORS `FetchFailure` IN `@growth-os/net` AND EXTENDS IT.
 *
 * The duplication is deliberate: `@growth-os/net` must not depend on
 * `@growth-os/contracts` — it is meant to be reviewable entirely on its own —
 * so the two lists are kept in agreement by a test rather than by an import.
 */
export const CRAWL_FAILURE_CATEGORIES = [
  // From the network layer
  'ssrf_blocked',
  'dns_failure',
  'connect_failed',
  'connect_timeout',
  'headers_timeout',
  'body_timeout',
  'total_timeout',
  'tls_error',
  'protocol_error',
  'redirect_limit',
  'redirect_refused',
  'response_too_large',
  'unsupported_content_type',
  'decode_error',
  'scheme_not_allowed',
  'credentials_present',
  'port_not_allowed',
  'host_missing',
  'host_too_long',
  'url_too_long',
  'sensitive_query',
  'unparseable',
  'cancelled',
  // From the crawler itself
  'robots_blocked',
  'parse_error',
  'http_4xx',
  'http_5xx',
] as const;
export type CrawlFailureCategory = (typeof CRAWL_FAILURE_CATEGORIES)[number];

export const CRAWL_FAILURE_LABELS: Readonly<Record<CrawlFailureCategory, string>> = {
  ssrf_blocked: 'Refused: private or reserved address',
  dns_failure: 'The name did not resolve',
  connect_failed: 'Could not connect',
  connect_timeout: 'Connection timed out',
  headers_timeout: 'The server did not respond in time',
  body_timeout: 'The response stalled',
  total_timeout: 'Took too long',
  tls_error: 'Certificate problem',
  protocol_error: 'Unexpected HTTP response',
  redirect_limit: 'Too many redirects',
  redirect_refused: 'Redirected off this site',
  response_too_large: 'Response too large',
  unsupported_content_type: 'Not an HTML page',
  decode_error: 'Could not decode the response',
  scheme_not_allowed: 'Not an http or https URL',
  credentials_present: 'The URL contained credentials',
  port_not_allowed: 'Unsupported port',
  host_missing: 'No host in the URL',
  host_too_long: 'Host name too long',
  url_too_long: 'URL too long',
  sensitive_query: 'The URL looked like a private link',
  unparseable: 'Not a valid URL',
  cancelled: 'Cancelled',
  robots_blocked: 'Blocked by robots.txt',
  parse_error: 'The HTML could not be parsed',
  http_4xx: 'Not found or refused',
  http_5xx: 'Server error',
};

/**
 * Whether a page is indexable, as a FACT derived only from what was fetched.
 *
 * ⚠️ THIS IS THE ONE PLACE STAGE 4 COMES CLOSE TO A JUDGEMENT, AND IT STOPS
 * SHORT ON PURPOSE. `noindex` present is a fact; "you should remove the
 * noindex" is a finding. This enum reports what the page SAYS about itself, and
 * says nothing about whether that is correct.
 */
export const INDEXABILITY_STATES = [
  'indexable',
  'noindex_meta',
  'noindex_header',
  'robots_disallowed',
  'non_canonical',
  'not_200',
] as const;
export type IndexabilityState = (typeof INDEXABILITY_STATES)[number];

export const INDEXABILITY_LABELS: Readonly<Record<IndexabilityState, string>> = {
  indexable: 'Indexable',
  noindex_meta: 'noindex (meta)',
  noindex_header: 'noindex (header)',
  robots_disallowed: 'Blocked by robots.txt',
  non_canonical: 'Canonical points elsewhere',
  not_200: 'Not a 200 response',
};

/** How a link relates to the site being crawled. */
export const LINK_SCOPES = ['internal', 'external', 'other_subdomain'] as const;
export type LinkScope = (typeof LINK_SCOPES)[number];
