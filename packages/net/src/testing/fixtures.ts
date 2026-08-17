/**
 * Test doubles for the network layer.
 *
 * ⚠️ WHY THESE EXIST, AND WHY THEY ARE NOT A BACKDOOR
 *
 * A crawler cannot be tested deterministically against the internet, and it
 * must not be tested against `localhost` — the one address the whole security
 * layer exists to refuse. The alternative that suggests itself is a flag:
 * `CRAWLER_ALLOW_PRIVATE=true`, on in tests, off in production.
 *
 * **There is no such flag anywhere in this package**, and there must never be
 * one. A control that can be disabled by configuration is a control that is one
 * environment variable away from being disabled in production by a tired
 * person at 2am.
 *
 * What is injected instead is the **transport and the resolver** — the two
 * pieces that touch the network. Every decision stays where it was:
 * `admitUrl` still runs, `classifyAddress` still runs on whatever the fixture
 * resolver returns, the redirect loop still re-enters the pipeline, the body
 * caps still apply. A test that points `evil.test` at `10.0.0.1` is exercising
 * the REAL classifier and gets a real refusal.
 *
 * The seam is where the packets go. The policy is not injectable.
 */

import type {
  Transport,
  TransportError,
  TransportRequest,
  TransportResponse,
} from '../http/transport';
import type { HostResolver, ResolvedAddress } from '../http/resolve';

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves names from a table.
 *
 * Counts its calls, so a test can prove that an IP literal was refused
 * **without a DNS query ever leaving the machine** — the difference between
 * "we rejected the response" and "we never asked".
 */
export class FixtureResolver implements HostResolver {
  readonly calls: string[] = [];

  constructor(private readonly table: Readonly<Record<string, readonly string[]>>) {}

  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    this.calls.push(hostname);
    const answers = this.table[hostname];
    if (!answers) {
      const error = new Error(`Fixture has no record for ${hostname}`) as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      throw error;
    }
    return answers.map((address) => ({
      address,
      family: address.includes(':') ? (6 as const) : (4 as const),
    }));
  }
}

/**
 * A resolver whose answer CHANGES between calls.
 *
 * This is the rebinding attacker: first answer public, every answer after it
 * private. Against a validate-then-fetch implementation it wins; against a
 * pinned one it never gets a second chance, because there is no second call.
 */
export class RebindingResolver implements HostResolver {
  private callCount = 0;
  readonly calls: string[] = [];

  constructor(
    private readonly first: readonly string[],
    private readonly thereafter: readonly string[],
  ) {}

  get resolutions(): number {
    return this.callCount;
  }

  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    this.calls.push(hostname);
    this.callCount += 1;
    const answers = this.callCount === 1 ? this.first : this.thereafter;
    return answers.map((address) => ({
      address,
      family: address.includes(':') ? (6 as const) : (4 as const),
    }));
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface FixtureResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
  /** Emit the body in pieces, to exercise streaming limits. */
  readonly chunks?: readonly (string | Buffer)[];
  /** Fail instead of responding. */
  readonly failure?: TransportError;
}

export interface AttemptedConnection {
  readonly url: string;
  readonly method: string;
  readonly address: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Serves responses from a table keyed by URL.
 *
 * ⚠️ IT RECORDS EVERY CONNECTION IT WAS ASKED TO MAKE.
 *
 * That list is the evidence in the headline security test: proving that a
 * blocked crawl produced **zero** attempted connections is stronger than
 * proving it returned an error, because an implementation could return an error
 * after opening the socket.
 */
export class FixtureTransport implements Transport {
  readonly attempts: AttemptedConnection[] = [];

  constructor(
    private readonly routes: Readonly<Record<string, FixtureResponse>>,
    private readonly fallback?: FixtureResponse,
  ) {}

  /** Every address a socket was opened to, in order. */
  get connectedAddresses(): readonly string[] {
    return this.attempts.map((attempt) => attempt.address);
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const address = request.addresses[0]?.address ?? '';
    const key = request.url.toString();

    this.attempts.push({
      url: key,
      method: request.method,
      address,
      headers: request.headers,
    });

    const route = this.routes[key] ?? this.routes[stripTrailingSlash(key)] ?? this.fallback;
    if (!route) {
      return {
        status: 404,
        headers: { 'content-type': 'text/plain' },
        body: emit([Buffer.from('not found')]),
        peerAddress: address,
      };
    }
    if (route.failure) throw route.failure;

    const pieces = route.chunks
      ? route.chunks.map((piece) => Buffer.from(piece))
      : [Buffer.from(route.body ?? '')];

    return {
      status: route.status,
      headers: route.headers ?? { 'content-type': 'text/html; charset=utf-8' },
      body: emit(pieces),
      peerAddress: address,
    };
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function* emit(pieces: readonly Buffer[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
}

/**
 * A transport that must never be called.
 *
 * Used where the assertion is "no connection was attempted at all". It throws
 * rather than recording, so a test cannot accidentally pass by ignoring a
 * counter it forgot to check.
 */
export class ForbiddenTransport implements Transport {
  async send(request: TransportRequest): Promise<TransportResponse> {
    throw new Error(
      `A connection was attempted to ${request.url.toString()} (${request.addresses[0]?.address}). ` +
        'This transport exists to prove that no socket is opened.',
    );
  }
}
