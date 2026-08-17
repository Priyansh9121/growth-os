/**
 * The transport: one request, to an address that was already validated.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Open exactly one connection, to exactly one of the addresses it was handed,
 * and stream the response back. It makes **no policy decisions** — no redirect
 * following, no scheme checking, no scope. Those live above it, in `fetch.ts`,
 * so that the fixture transport used by tests exercises the identical policy.
 *
 * ⚠️ WHY `node:https` AND NOT A CLIENT LIBRARY
 *
 * Every popular HTTP client follows redirects for you. That is precisely the
 * behaviour this design cannot have: a followed redirect is a second connection
 * to a second host, and if the library performs it, the library resolved that
 * host — outside our resolver, outside our classifier, and outside our pinning.
 * A crawler built on a client with `maxRedirects: 5` has an SSRF layer that the
 * client politely steps around.
 *
 * `http.request` never follows a redirect. It also accepts a `lookup` function,
 * which is the mechanism that makes pinning real rather than advisory.
 *
 * The cost is that response streaming, timeouts and decompression are ours to
 * write. That is the correct trade for the one module in the product whose
 * failure mode is "reads the cloud metadata endpoint".
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { ResolvedAddress } from './resolve';

export interface Timeouts {
  /** TCP connect and TLS handshake. */
  readonly connectMs: number;
  /** From request sent to response headers received. */
  readonly headersMs: number;
  /** Maximum gap between body chunks. Defeats a byte-per-minute trickle. */
  readonly bodyIdleMs: number;
  /** Wall-clock ceiling for the whole exchange, whatever else is happening. */
  readonly totalMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  connectMs: 5_000,
  headersMs: 10_000,
  bodyIdleMs: 10_000,
  totalMs: 30_000,
};

export interface TransportRequest {
  readonly url: URL;
  readonly method: 'GET' | 'HEAD';
  readonly headers: Readonly<Record<string, string>>;
  /**
   * ⚠️ EVERY ONE OF THESE HAS BEEN CLASSIFIED AND ALLOWED.
   *
   * The transport connects to one of them and to nothing else. It must never
   * resolve `url.hostname` itself — that is the rebinding window this whole
   * arrangement exists to close.
   */
  readonly addresses: readonly ResolvedAddress[];
  readonly timeouts: Timeouts;
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  /**
   * The address actually connected to.
   *
   * Recorded so a test can assert that the socket went where the classifier
   * said it could — the difference between "we validated an address" and "we
   * used the address we validated".
   */
  readonly peerAddress: string;
}

export type TransportFailure =
  | 'connect_failed'
  | 'connect_timeout'
  | 'headers_timeout'
  | 'body_timeout'
  | 'total_timeout'
  | 'tls_error'
  | 'cancelled'
  | 'protocol_error';

export class TransportError extends Error {
  constructor(
    readonly failure: TransportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

/**
 * The production transport.
 */
export class NodeTransport implements Transport {
  async send(request: TransportRequest): Promise<TransportResponse> {
    const { url, addresses, timeouts, signal } = request;
    const secure = url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;

    const first = addresses[0];
    if (!first) throw new TransportError('connect_failed', 'No validated address to connect to');

    /**
     * ⚠️ THIS IS THE PIN.
     *
     * `net.connect` calls `lookup` to turn a hostname into an address. Ours
     * ignores the hostname entirely and returns the addresses that were already
     * validated. No query is issued, so there is no second answer to differ
     * from the first, and the address the classifier approved is the address
     * the kernel dials.
     */
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options !== null && options.all === true) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
          null,
          addresses.map((a) => ({ address: a.address, family: a.family })),
        );
        return;
      }
      callback(null, first.address, first.family);
    };

    return new Promise<TransportResponse>((resolve, reject) => {
      let settled = false;
      const fail = (failure: TransportFailure, message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(headersTimer);
        outgoing.destroy();
        reject(new TransportError(failure, message));
      };

      const totalTimer = setTimeout(
        () => fail('total_timeout', `Exceeded ${timeouts.totalMs}ms overall`),
        timeouts.totalMs,
      );
      const headersTimer = setTimeout(
        () => fail('headers_timeout', `No response headers within ${timeouts.headersMs}ms`),
        timeouts.headersMs,
      );

      const outgoing = send({
        protocol: url.protocol,
        // `hostname`, not `host`: Node derives the `Host` header from it, so
        // the request still names the site rather than the pinned address.
        // A virtual host serving 400 sites must see the right one.
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: request.headers,
        lookup: pinnedLookup,
        // ⚠️ TLS VERIFICATION IS UNTOUCHED, and `servername` is set explicitly
        // so SNI and certificate validation both use the HOSTNAME. Pinning
        // changes where the packets go, never whether the certificate is
        // checked — a crawler that disabled verification to make pinning work
        // would have traded one vulnerability for another.
        ...(secure ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
        // Not `agent: false`, and not a keep-alive pool either: one connection
        // per request keeps the pinning trivially true. Connection reuse across
        // requests would mean a later request riding a socket opened for an
        // earlier validation.
        agent: undefined,
      });

      outgoing.setTimeout(timeouts.connectMs, () => {
        if (!outgoing.socket?.remoteAddress) {
          fail('connect_timeout', `No connection within ${timeouts.connectMs}ms`);
        }
      });

      const onAbort = (): void => fail('cancelled', 'Cancelled');
      signal.addEventListener('abort', onAbort, { once: true });

      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        signal.removeEventListener('abort', onAbort);
        const code = error.code ?? '';
        if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.startsWith('UNABLE_')) {
          fail('tls_error', code);
        } else if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
          fail('connect_failed', code);
        } else if (code === 'ETIMEDOUT') {
          fail('connect_timeout', code);
        } else {
          fail('protocol_error', code || 'Request failed');
        }
      });

      outgoing.on('response', (incoming: IncomingMessage) => {
        clearTimeout(headersTimer);
        if (settled) {
          incoming.destroy();
          return;
        }
        settled = true;

        const peerAddress = incoming.socket.remoteAddress ?? first.address;

        resolve({
          status: incoming.statusCode ?? 0,
          headers: normaliseHeaders(incoming.headers),
          peerAddress,
          body: streamBody(incoming, timeouts, totalTimer, signal, onAbort),
        });
      });

      outgoing.end();
    });
  }
}

/**
 * The body as an async iterable, with an idle timeout between chunks.
 *
 * A response that sends one byte a minute holds a worker slot indefinitely and
 * never trips a total timeout that only measures headers. This is what makes a
 * slowloris a bounded failure rather than a stuck crawl.
 */
async function* streamBody(
  incoming: IncomingMessage,
  timeouts: Timeouts,
  totalTimer: NodeJS.Timeout,
  signal: AbortSignal,
  onAbort: () => void,
): AsyncGenerator<Uint8Array> {
  incoming.setTimeout(timeouts.bodyIdleMs, () => {
    incoming.destroy(new TransportError('body_timeout', 'Body stalled'));
  });

  try {
    for await (const chunk of incoming) {
      if (signal.aborted) throw new TransportError('cancelled', 'Cancelled');
      yield chunk as Uint8Array;
    }
  } finally {
    clearTimeout(totalTimer);
    signal.removeEventListener('abort', onAbort);
    incoming.destroy();
  }
}

function normaliseHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    // Repeated headers join with a comma, which is what every consumer here
    // expects. `set-cookie` is the exception in HTTP — and the crawler stores
    // no cookies at all, so it is dropped rather than joined.
    if (key === 'set-cookie') continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
