/**
 * Fetching a sitemap, and deciding what its absence means.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn an HTTP outcome into a list of URLs the site claims exists, or into an
 * honest statement that we do not have one. `parse.ts` answers "what does this
 * document say"; this answers "what may we do when we could not read it".
 *
 * ⚠️ THE FAIL-OPEN RULE, AND WHY IT IS THE OPPOSITE OF robots.txt
 *
 * `fetchRobots` fails CLOSED — a 5xx or a network error disallows the entire
 * site, because "we could not read robots.txt" is not "robots.txt permits
 * this". Reading that decision and applying it here would be exactly wrong.
 *
 * **A sitemap grants nothing.** It is the site's own list of pages: an
 * optimisation over discovering them by following links, not a permission
 * artefact. Failing to read one removes a shortcut, not an authorisation. Most
 * sites do not publish a sitemap at all, so treating its absence the way
 * robots' absence is treated would make the majority of the web uncrawlable.
 *
 * `siteDisallowed` is therefore `false` on every branch of this file, and a
 * property test asserts it over all of them rather than trusting the reader to
 * check each one.
 *
 * ⚠️ `401` AND `403` DIVERGE FROM robots.txt DELIBERATELY. There they are
 * fail-closed: a site that authenticates its rules is telling us we are not an
 * audience for them. A site that authenticates its sitemap is telling us
 * nothing about permission — only that this file is not public.
 *
 * @see docs/decisions/ADR-0051-sitemap-fetch-is-fail-open.md
 */

import { gunzipSync } from 'node:zlib';
import { safeFetch, type SafeFetchDependencies } from '@growth-os/net';
import {
  DEFAULT_SITEMAP_LIMITS,
  parseSitemap,
  type SitemapDocument,
  type SitemapLimits,
} from './parse';

/** What a sitemap fetch established. */
export type SitemapFetchOutcome = 'fetched' | 'absent' | 'unavailable' | 'error' | 'not_a_sitemap';

export interface SitemapState {
  readonly outcome: SitemapFetchOutcome;
  /** The parsed document, or `null` when there is nothing to parse. */
  readonly document: SitemapDocument | null;
  /**
   * ⚠️ ALWAYS FALSE, AND PRESENT ON PURPOSE.
   *
   * It mirrors `RobotsState.siteDisallowed` so the two are comparable at a
   * glance, and so the asymmetry is visible in the type rather than only in a
   * comment. A future contributor tempted to set it here should read
   * ADR-0051 first.
   */
  readonly siteDisallowed: false;
  /** Safe to show an operator. Never a stack trace. */
  readonly detail: string;
  /** Where it was fetched from. Recorded so the crawl is reproducible. */
  readonly url: string;
}

export interface FetchSitemapOptions {
  readonly limits?: SitemapLimits;
  /**
   * Bytes accepted on the wire.
   *
   * ⚠️ BOTH TIERS ARE STATED WHERE THIS IS USED, NOT ONE (ADR-0049). Overriding
   * `maxCompressedBytes` alone would inherit `maxDecompressedBytes` from
   * `DEFAULT_LIMITS` and adopt an expansion ratio nobody chose — `resolveLimits`
   * now throws rather than allowing it.
   */
  readonly maxCompressedBytes?: number;
}

/** 2 MB on the wire, 8 MB decompressed — the same 4× ratio as the defaults. */
const DEFAULT_TRANSFER_CEILING = 2 * 1024 * 1024;
const EXPANSION_RATIO = 4;

/** `1f 8b` — the gzip magic number. */
const isGzip = (body: Buffer): boolean => body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;

/**
 * Fetch and parse a sitemap.
 *
 * ⚠️ THROUGH `safeFetch`, LIKE EVERYTHING ELSE (§5). A sitemap URL comes from a
 * customer's site or from its robots.txt, which makes it precisely the wrong
 * place for a convenience client.
 */
export async function fetchSitemap(
  network: SafeFetchDependencies,
  url: string,
  options: FetchSitemapOptions = {},
): Promise<SitemapState> {
  const limits = options.limits ?? DEFAULT_SITEMAP_LIMITS;
  const transferCeiling = options.maxCompressedBytes ?? DEFAULT_TRANSFER_CEILING;

  const outcome = await safeFetch(network, url, {
    // ⚠️ NOT constrained by content type. Real servers serve sitemaps as
    // text/plain, application/octet-stream and text/html; refusing on the
    // header would lose lists we can read perfectly well.
    limits: {
      maxCompressedBytes: transferCeiling,
      maxDecompressedBytes: transferCeiling * EXPANSION_RATIO,
      maxRedirects: 5,
    },
  });

  if (!outcome.ok) {
    // Includes the SSRF refusal. A sitemap resolving to a private address is
    // not one we read — and it still says nothing about crawling the site.
    return {
      outcome: 'error',
      document: null,
      siteDisallowed: false,
      detail: `Could not read the sitemap (${outcome.failure}). Crawling continues from the pages we already know.`,
      url,
    };
  }

  const status = outcome.status;

  if (status >= 200 && status < 300) {
    const body = decompressIfNeeded(outcome.body, transferCeiling * EXPANSION_RATIO);
    if (body === null) {
      return {
        outcome: 'not_a_sitemap',
        document: null,
        siteDisallowed: false,
        detail: 'The sitemap was compressed in a way we could not read.',
        url,
      };
    }

    const document = parseSitemap(body.toString('utf8'), url, limits);
    if (document.kind === 'unknown') {
      return {
        outcome: 'not_a_sitemap',
        document: null,
        siteDisallowed: false,
        detail: 'That address did not return a sitemap.',
        url,
      };
    }

    return {
      outcome: 'fetched',
      document,
      siteDisallowed: false,
      detail: document.truncated
        ? 'The sitemap was larger than we read; the URLs we read are used.'
        : 'Sitemap read.',
      url,
    };
  }

  if (status >= 400 && status < 500) {
    // The definite answer: there is no sitemap here. Most sites are here, and
    // `401`/`403` join them — see the header.
    return {
      outcome: 'absent',
      document: null,
      siteDisallowed: false,
      detail: `No sitemap (${status}). Pages are discovered by following links instead.`,
      url,
    };
  }

  return {
    outcome: 'unavailable',
    document: null,
    siteDisallowed: false,
    detail: `The sitemap returned ${status}. Pages are discovered by following links instead.`,
    url,
  };
}

/**
 * Decompress a `.gz` file body.
 *
 * ⚠️ WHY THIS EXISTS WHEN `safeFetch` ALREADY DECOMPRESSES. `safeFetch` acts on
 * `content-encoding`, which is what a server sets when it compresses a response
 * in transit. `sitemap.xml.gz` is different: the *file* is compressed, served
 * with `content-type: application/gzip` and usually **no** `content-encoding`
 * at all. Those bytes arrive compressed and never touch the decompressed tier.
 *
 * ⚠️ SO THE BOUND HERE IS NOT OPTIONAL — it is the only one that applies.
 * `maxOutputLength` aborts the inflate rather than allocating first, so a
 * 64 MB-from-64 KB bomb costs nothing. Measured: it throws
 * `ERR_BUFFER_TOO_LARGE`.
 *
 * This is not a second network path (§5). The request is already complete and
 * both transport tiers have already applied; this is parsing a body we hold.
 */
function decompressIfNeeded(body: Buffer, maxOutputLength: number): Buffer | null {
  if (!isGzip(body)) return body;

  try {
    return gunzipSync(body, { maxOutputLength });
  } catch {
    return null;
  }
}
