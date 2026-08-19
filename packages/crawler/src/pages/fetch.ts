/**
 * Fetching one page.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn one URL into a set of facts about the response. That is all it does, and
 * the narrowness is the point: a status, a media type, a duration, a byte
 * count. Never "this page looks broken", never a severity, never a
 * recommendation (§5, facts vs findings).
 *
 * ⚠️ THIS IS THE CRAWLER'S FIRST PAGE-FETCH PATH. Verified before writing it:
 * the only `safeFetch` callers were `robots/fetch.ts`, `sitemap/fetch.ts` and
 * site verification. There was no page fetch to reuse or extend.
 *
 * ⚠️ IT DOES NOT PARSE THE BODY. No links, no title, no text. HTML extraction
 * is a separate brief, so a crawl driven by this discovers pages only from the
 * seed and from sitemaps.
 *
 * ⚠️ THE SSRF PIPELINE RUNS HERE EVEN THOUGH THE URL PASSED ADMISSION.
 * A frontier row was admitted once, possibly minutes ago. Admission and
 * fetch-time defence are different hops: DNS can resolve to a public address
 * when the URL is queued and a private one when it is fetched, which is the
 * rebinding window `safeFetch` pins against. Skipping the fetch-time hop
 * because "it was already checked" is exactly the fast path §5 forbids.
 *
 * @see docs/decisions/ADR-0053-the-crawl-run.md
 */

import { safeFetch, type SafeFetchDependencies } from '@growth-os/net';
import type { CrawlFailureCategory, PageFetchOutcome } from '@growth-os/contracts';

/**
 * What one fetch established. Every field is a fact about the response.
 *
 * Shaped to `crawl_pages`'s response columns, so `markFetched` can spread it
 * without a translation layer inventing a second vocabulary.
 */
export interface PageObservation {
  readonly outcome: PageFetchOutcome;
  readonly failureCategory: CrawlFailureCategory | null;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly fetchDurationMs: number;
  /** The URL finally fetched, when redirects moved it. Null when unchanged. */
  readonly finalUrl: string | null;
  readonly redirectCount: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** Bytes accepted. Summed onto the crawl as an operational cost signal. */
  readonly bytes: number;
}

export interface FetchPageOptions {
  /** Bytes accepted on the wire. Both tiers are stated where used (ADR-0049). */
  readonly maxCompressedBytes?: number;
}

/** 2 MB on the wire, 8 MB decompressed — the same 4× ratio as the defaults. */
const DEFAULT_TRANSFER_CEILING = 2 * 1024 * 1024;
const EXPANSION_RATIO = 4;

/**
 * Failures that were OUR refusal rather than the network's.
 *
 * ⚠️ THE SPLIT IS "WHO DECIDED", NOT "HOW BAD". `blocked` means a policy
 * refused this — the SSRF classifier, the URL policy, a content type we do not
 * accept, a body over the cap. `failed` means we tried and the network did not
 * cooperate. An operator reading "blocked" should look at their site's
 * configuration; reading "failed" they should look at their server.
 */
const POLICY_REFUSALS: ReadonlySet<string> = new Set([
  'ssrf_blocked',
  'unsupported_content_type',
  'response_too_large',
  'redirect_refused',
  'scheme_not_allowed',
  'credentials_present',
  'port_not_allowed',
  'host_missing',
  'host_too_long',
  'url_too_long',
  'sensitive_query',
  'unparseable',
]);

/**
 * Every `FetchFailure` is currently also a `CrawlFailureCategory`.
 *
 * ⚠️ MEASURED, NOT ASSUMED, AND NOT GUARANTEED. All 23 literals in
 * `@growth-os/net`'s failure unions appear in `CRAWL_FAILURE_CATEGORIES` today.
 * The contracts file claims "the two lists are kept in agreement by a test
 * rather than by an import" — **that test does not exist in the repository**
 * (dev log 0034). So this narrows defensively rather than casting: an unknown
 * value becomes `null` and the row still records the outcome, instead of the
 * insert failing on an enum the database has never heard of.
 */
const CRAWL_FAILURES: ReadonlySet<string> = new Set([
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
]);

const asCrawlFailure = (failure: string): CrawlFailureCategory | null =>
  CRAWL_FAILURES.has(failure) ? (failure as CrawlFailureCategory) : null;

/** `text/html; charset=utf-8` → `text/html`. The parameters are not the type. */
const mediaType = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const type = header.split(';')[0]?.trim().toLowerCase();
  return type !== undefined && type.length > 0 ? type : null;
};

const header = (headers: Readonly<Record<string, string>>, name: string): string | null =>
  headers[name] ?? null;

/**
 * Fetch one page and record what happened.
 *
 * ⚠️ NOT constrained by content type. A crawl records what a URL returned,
 * including that it returned a PDF — refusing on the header would lose the fact
 * rather than record it. The body cap is what bounds the cost.
 */
export async function fetchPage(
  network: SafeFetchDependencies,
  url: string,
  options: FetchPageOptions = {},
): Promise<PageObservation> {
  const ceiling = options.maxCompressedBytes ?? DEFAULT_TRANSFER_CEILING;

  const outcome = await safeFetch(network, url, {
    limits: {
      maxCompressedBytes: ceiling,
      maxDecompressedBytes: ceiling * EXPANSION_RATIO,
      maxRedirects: 5,
    },
  });

  if (!outcome.ok) {
    return {
      outcome: POLICY_REFUSALS.has(outcome.failure) ? 'blocked' : 'failed',
      failureCategory: asCrawlFailure(outcome.failure),
      httpStatus: null,
      contentType: null,
      contentLength: null,
      fetchDurationMs: outcome.durationMs,
      finalUrl: null,
      redirectCount: outcome.redirects.length,
      etag: null,
      lastModified: null,
      bytes: 0,
    };
  }

  const status = outcome.status;
  const moved = outcome.url !== outcome.requestedUrl;

  return {
    outcome: outcomeForStatus(status),
    failureCategory: failureForStatus(status),
    httpStatus: status,
    contentType: mediaType(outcome.headers['content-type']),
    contentLength: outcome.body.byteLength,
    fetchDurationMs: outcome.durationMs,
    finalUrl: moved ? outcome.url : null,
    redirectCount: outcome.redirects.length,
    etag: header(outcome.headers, 'etag'),
    lastModified: header(outcome.headers, 'last-modified'),
    bytes: outcome.body.byteLength,
  };
}

function outcomeForStatus(status: number): PageFetchOutcome {
  if (status === 304) return 'unchanged';
  if (status >= 200 && status < 300) return 'fetched';
  if (status >= 300 && status < 400) return 'redirected';
  if (status >= 400 && status < 500) return 'http_4xx';
  return 'http_5xx';
}

function failureForStatus(status: number): CrawlFailureCategory | null {
  if (status >= 400 && status < 500) return 'http_4xx';
  if (status >= 500) return 'http_5xx';
  return null;
}
