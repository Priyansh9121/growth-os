/**
 * `safeFetch` — the only way Growth OS makes an outbound request to an address
 * a customer supplied.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Compose the four controls into one call, and apply **all of them at every
 * hop**:
 *
 *      admitUrl            scheme · credentials · port · sensitive query
 *          ↓
 *      resolveAndValidate  every DNS answer classified, addresses pinned
 *          ↓
 *      transport           connects to a pinned address; TLS still verified
 *          ↓
 *      readBody            compressed cap · decompressed cap · idle timeout
 *          ↓
 *      3xx? ──────────────▶ back to the top, with the redirect target
 *
 * ⚠️ THE LOOP IS THE POINT.
 *
 * The single most common SSRF failure in a crawler is validating the URL a user
 * typed and then letting the HTTP client follow `302 Location:
 * http://169.254.169.254/`. Redirects are handled here, one at a time, and each
 * target re-enters the pipeline from the first line. There is no configuration
 * that turns that off, because the transport cannot follow a redirect even if
 * asked — `http.request` has no such feature.
 *
 * ⚠️ IT RETURNS FAILURES, IT DOES NOT THROW THEM.
 *
 * A crawler's failures are data: "this page timed out", "this redirect left the
 * site", "this host resolved to a private address". A thrown exception is
 * something a caller can forget to catch and a `catch {}` can erase. Every
 * outcome here is a value with a typed category.
 *
 * @see docs/security/crawler-ssrf-threat-model.md
 * @see ADR-0032
 */

import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { admitUrl, bareHost, type UrlRejection } from '../url/policy';
import {
  resolveAndValidate,
  SystemResolver,
  type HostResolver,
  type ResolvedAddress,
} from './resolve';
import {
  DEFAULT_TIMEOUTS,
  NodeTransport,
  TransportError,
  type Timeouts,
  type Transport,
  type TransportFailure,
} from './transport';

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * Every way a fetch can fail, as a closed set.
 *
 * Typed rather than free text because these are counted, stored on a crawl
 * page, and shown to an operator. "Something went wrong" is not a category a
 * customer can act on, and a raw stack trace is not something a customer should
 * ever see.
 */
export type FetchFailure =
  | UrlRejection
  | TransportFailure
  | 'ssrf_blocked'
  | 'dns_failure'
  | 'redirect_limit'
  | 'redirect_refused'
  | 'response_too_large'
  | 'unsupported_content_type'
  | 'decode_error';

export interface FetchRedirectHop {
  readonly from: string;
  readonly to: string;
  readonly status: number;
}

export interface FetchSuccess {
  readonly ok: true;
  /** The URL finally fetched, after redirects. */
  readonly url: string;
  /** The URL originally asked for. */
  readonly requestedUrl: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  /** True when the body hit the cap and was cut short. */
  readonly truncated: boolean;
  readonly redirects: readonly FetchRedirectHop[];
  /** The address the socket actually connected to, for the final hop. */
  readonly peerAddress: string;
  readonly durationMs: number;
}

export interface FetchBlocked {
  readonly ok: false;
  readonly failure: FetchFailure;
  /** Stable sub-rule where one exists: `loopback`, `private-a`, `ENOTFOUND`. */
  readonly rule: string;
  /** Safe to show an operator. Never a stack trace, never a secret. */
  readonly detail: string;
  /** The URL that was refused — already known safe to record, or redacted. */
  readonly url: string;
  readonly redirects: readonly FetchRedirectHop[];
  readonly durationMs: number;
}

export type FetchOutcome = FetchSuccess | FetchBlocked;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface ResponseLimits {
  /**
   * Bytes accepted on the wire, before decompression.
   *
   * 2 MB is generous for HTML — the 95th percentile page is well under 200 KB —
   * and small enough that a hostile origin cannot make one page cost more than
   * a few hundred of them.
   */
  readonly maxCompressedBytes: number;
  /**
   * Bytes accepted AFTER decompression.
   *
   * ⚠️ THE SEPARATE CAP IS THE WHOLE POINT. A 10 KB gzip stream can expand to
   * a gigabyte; a single limit on the compressed size is not a limit at all.
   * The decompressor is aborted mid-stream when this is reached rather than
   * after, so the memory is never allocated.
   */
  readonly maxDecompressedBytes: number;
  readonly maxRedirects: number;
}

export const DEFAULT_LIMITS: ResponseLimits = {
  maxCompressedBytes: 2 * 1024 * 1024,
  maxDecompressedBytes: 8 * 1024 * 1024,
  /**
   * Five. Enough for the chains real sites have — http→https, apex→www,
   * trailing slash, a CMS canonicalisation — and short enough that a redirect
   * loop is a bounded failure rather than a stuck worker.
   */
  maxRedirects: 5,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SafeFetchDependencies {
  readonly resolver: HostResolver;
  readonly transport: Transport;
}

/** Production wiring. Tests pass their own resolver and transport. */
export function productionNetwork(): SafeFetchDependencies {
  return { resolver: new SystemResolver(), transport: new NodeTransport() };
}

export interface SafeFetchOptions {
  readonly method?: 'GET' | 'HEAD';
  readonly headers?: Readonly<Record<string, string>>;
  readonly limits?: Partial<ResponseLimits>;
  readonly timeouts?: Partial<Timeouts>;
  readonly signal?: AbortSignal;
  /**
   * Content types the caller will accept, matched against the media type with
   * parameters stripped. Omitted means anything.
   *
   * The crawler uses this to refuse a 60 MB video that a link pointed at,
   * WITHOUT downloading it: the check runs on the response headers, before the
   * body is read.
   */
  readonly acceptContentTypes?: readonly string[];
  /**
   * Applied to every redirect target, in addition to the security pipeline.
   *
   * This is where **crawl scope** lives: the network layer has no opinion about
   * which origin belongs to a customer, and the crawler has no business
   * re-implementing SSRF checks. Returning `false` produces `redirect_refused`.
   */
  readonly allowRedirect?: (from: URL, to: URL) => boolean;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function safeFetch(
  deps: SafeFetchDependencies,
  requestedUrl: string,
  options: SafeFetchOptions = {},
): Promise<FetchOutcome> {
  const startedAt = Date.now();
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const timeouts: Timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const redirects: FetchRedirectHop[] = [];

  const controller = new AbortController();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const blocked = (
    failure: FetchFailure,
    rule: string,
    detail: string,
    url: string,
  ): FetchBlocked => ({
    ok: false,
    failure,
    rule,
    detail,
    url,
    redirects,
    durationMs: Date.now() - startedAt,
  });

  let current = requestedUrl;
  let previous: URL | null = null;

  // `<=` rather than `<`: the initial request is not a redirect, so a limit of
  // five means five HOPS after it.
  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    // -- 1. URL policy, on every hop, including redirect targets ------------
    const admitted = admitUrl(current);
    if (!admitted.ok) {
      return blocked(admitted.rejection, admitted.rejection, admitted.detail, current);
    }
    const url = admitted.url;

    // -- 2. Scope, when the caller supplied one -----------------------------
    if (previous && options.allowRedirect && !options.allowRedirect(previous, url)) {
      return blocked(
        'redirect_refused',
        'out_of_scope',
        `Redirect to ${url.origin} is outside the crawl scope`,
        url.toString(),
      );
    }

    // -- 3. Resolve and pin -------------------------------------------------
    const resolution = await resolveAndValidate(bareHost(url), deps.resolver);
    if (!resolution.ok) {
      return blocked(resolution.category, resolution.rule, resolution.reason, url.toString());
    }

    // -- 4. One connection --------------------------------------------------
    let response;
    try {
      response = await deps.transport.send({
        url,
        method: options.method ?? 'GET',
        headers: buildHeaders(url, options.headers),
        addresses: resolution.addresses satisfies readonly ResolvedAddress[],
        timeouts,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof TransportError) {
        return blocked(error.failure, error.failure, error.message, url.toString());
      }
      return blocked('protocol_error', 'unknown', 'The request failed', url.toString());
    }

    // -- 5. Redirect? -------------------------------------------------------
    if (isRedirect(response.status)) {
      const location = response.headers['location'];
      // Draining matters: an undrained response keeps the socket open until the
      // idle timeout fires, and a crawl of a redirect-heavy site would hold one
      // socket per page for ten seconds each.
      await drain(response.body);

      if (!location) {
        return blocked(
          'protocol_error',
          'redirect_without_location',
          `HTTP ${response.status} with no Location header`,
          url.toString(),
        );
      }

      let target: string;
      try {
        // Relative Locations are legal and common. Resolving against the
        // CURRENT url — not the originally requested one — is what makes a
        // chain behave the way a browser's does.
        target = new URL(location, url).toString();
      } catch {
        return blocked(
          'unparseable',
          'bad_location',
          'The Location header is not a URL',
          url.toString(),
        );
      }

      redirects.push({ from: url.toString(), to: target, status: response.status });
      previous = url;
      current = target;
      continue;
    }

    // -- 6. Content type, BEFORE the body ----------------------------------
    if (options.acceptContentTypes) {
      const mediaType = (response.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (!mediaType || !options.acceptContentTypes.includes(mediaType)) {
        await drain(response.body);
        return blocked(
          'unsupported_content_type',
          mediaType || 'missing',
          `Content-Type ${mediaType || '(absent)'} is not one this request accepts`,
          url.toString(),
        );
      }
    }

    // -- 7. Body, under both caps ------------------------------------------
    const declared = Number(response.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > limits.maxCompressedBytes) {
      // The header is a hint an origin controls, so it can only make us refuse
      // EARLIER. The real enforcement is counting bytes below.
      await drain(response.body);
      return blocked(
        'response_too_large',
        'content_length',
        `Content-Length ${declared} exceeds ${limits.maxCompressedBytes}`,
        url.toString(),
      );
    }

    let read;
    try {
      read = await readBody(response.body, response.headers['content-encoding'], limits);
    } catch (error) {
      if (error instanceof TransportError) {
        return blocked(error.failure, error.failure, error.message, url.toString());
      }
      return blocked(
        'decode_error',
        'decompression_failed',
        'The response body could not be decoded',
        url.toString(),
      );
    }

    if (read.overLimit) {
      return blocked(
        'response_too_large',
        read.overLimit,
        `The response exceeded the ${read.overLimit} limit`,
        url.toString(),
      );
    }

    return {
      ok: true,
      url: url.toString(),
      requestedUrl,
      status: response.status,
      headers: response.headers,
      body: read.body,
      truncated: false,
      redirects,
      peerAddress: response.peerAddress,
      durationMs: Date.now() - startedAt,
    };
  }

  return blocked(
    'redirect_limit',
    'too_many',
    `More than ${limits.maxRedirects} redirects`,
    current,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildHeaders(
  url: URL,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return {
    host: url.host,
    'accept-encoding': 'gzip, deflate, br',
    // No cookies are ever sent, and none are ever stored. A crawler with a
    // cookie jar accumulates one site's session and carries it to the next.
    ...extra,
  };
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const _chunk of body) {
      /* discard */
    }
  } catch {
    /* a body we are throwing away cannot fail in a way that matters */
  }
}

interface BodyRead {
  readonly body: Buffer;
  /** Which cap was hit, or null. */
  readonly overLimit: 'compressed' | 'decompressed' | null;
}

/**
 * Read a body under both caps, decompressing as it goes.
 *
 * ⚠️ THE CAPS ARE ENFORCED DURING THE STREAM, NOT AFTER IT.
 *
 * Checking `buffer.length` at the end is not a limit — by then the memory has
 * been allocated, which is exactly what a compression bomb is spending. Both
 * counters abort mid-stream.
 */
async function readBody(
  source: AsyncIterable<Uint8Array>,
  contentEncoding: string | undefined,
  limits: ResponseLimits,
): Promise<BodyRead> {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();

  let compressedBytes = 0;
  const counted = (async function* () {
    for await (const chunk of source) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > limits.maxCompressedBytes) {
        throw new OverLimit('compressed');
      }
      yield chunk;
    }
  })();

  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;

  const stream = decoder ? Readable.from(counted).pipe(decoder) : Readable.from(counted);

  const chunks: Buffer[] = [];
  let decompressedBytes = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Uint8Array);
      decompressedBytes += buffer.byteLength;
      if (decompressedBytes > limits.maxDecompressedBytes) {
        throw new OverLimit('decompressed');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof OverLimit) {
      decoder?.destroy();
      return { body: Buffer.alloc(0), overLimit: error.which };
    }
    throw error;
  }

  return { body: Buffer.concat(chunks), overLimit: null };
}

class OverLimit extends Error {
  constructor(readonly which: 'compressed' | 'decompressed') {
    super(`over ${which} limit`);
  }
}
