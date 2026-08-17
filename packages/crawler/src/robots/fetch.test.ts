/**
 * robots.txt fetch semantics — what each HTTP outcome means.
 *
 * WHY THIS SUITE MATTERS MORE THAN THE PARSER'S
 * Parsing is decided by a spec. THIS is where the product makes a judgement
 * nobody else made for us: what to do when the file cannot be read. Getting it
 * wrong in the permissive direction means hitting a struggling server with five
 * hundred requests at the exact moment it is failing.
 *
 * Every case asserts `siteDisallowed`, which is the flag that actually stops a
 * crawl — not merely that a status was categorised.
 */

import { describe, expect, it } from 'vitest';
import { TransportError, type SafeFetchDependencies } from '@growth-os/net';
import { FixtureResolver, FixtureTransport, ForbiddenTransport } from '@growth-os/net/testing';
import { fetchRobots, robotsCacheScope } from './fetch';
import { isAllowed } from './parse';

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';
const ROBOTS_URL = `${ORIGIN}/robots.txt`;

function network(response: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  failure?: TransportError;
}): SafeFetchDependencies {
  return {
    resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
    transport: new FixtureTransport({ [ROBOTS_URL]: response }),
  };
}

describe('2xx — the rules apply', () => {
  it('parses the file and permits crawling', async () => {
    const state = await fetchRobots(
      network({ status: 200, body: 'User-agent: *\nDisallow: /admin' }),
      ORIGIN,
    );

    expect(state.outcome).toBe('fetched');
    expect(state.siteDisallowed).toBe(false);
    expect(isAllowed(state.rules, `${ORIGIN}/admin/x`).allowed).toBe(false);
    expect(isAllowed(state.rules, `${ORIGIN}/about`).allowed).toBe(true);
  });

  it('accepts whatever content type the server sends', async () => {
    // Real servers serve robots.txt as text/html and octet-stream. Refusing on
    // the header would fail closed against rules we can read perfectly well.
    const state = await fetchRobots(
      network({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: 'User-agent: *\nDisallow: /x',
      }),
      ORIGIN,
    );

    expect(state.outcome).toBe('fetched');
    expect(isAllowed(state.rules, `${ORIGIN}/x`).allowed).toBe(false);
  });

  it('applies the rules it could read when the file was truncated', async () => {
    const huge = `User-agent: *\nDisallow: /x\n${'# pad\n'.repeat(200_000)}`;
    const state = await fetchRobots(network({ status: 200, body: huge }), ORIGIN);

    expect(state.outcome).toBe('fetched');
    expect(state.siteDisallowed).toBe(false);
    // ⚠️ Truncation is not permission.
    expect(isAllowed(state.rules, `${ORIGIN}/x`).allowed).toBe(false);
    expect(state.detail).toContain('larger than we parse');
  });

  it('an empty 200 permits everything', async () => {
    const state = await fetchRobots(network({ status: 200, body: '' }), ORIGIN);
    expect(state.outcome).toBe('fetched');
    expect(state.siteDisallowed).toBe(false);
    expect(isAllowed(state.rules, `${ORIGIN}/anything`).allowed).toBe(true);
  });
});

describe('4xx — unrestricted, because it is a definite answer', () => {
  it.each([404, 410, 400, 418, 429])('%i permits crawling', async (status) => {
    const state = await fetchRobots(network({ status, body: '' }), ORIGIN);

    expect(state.outcome).toBe('absent');
    expect(state.siteDisallowed).toBe(false);
    expect(isAllowed(state.rules, `${ORIGIN}/anything`).allowed).toBe(true);
  });

  it('a 404 is the common case and must not block a crawl', async () => {
    // Most sites have no robots.txt. Failing closed here would make the
    // crawler useless against the majority of the customer base.
    const state = await fetchRobots(network({ status: 404 }), ORIGIN);
    expect(state.siteDisallowed).toBe(false);
    expect(state.detail).toContain('unrestricted');
  });
});

describe('⚠️ fail-closed — the whole site is refused', () => {
  it.each([500, 502, 503, 504, 599])('%i disallows the entire site', async (status) => {
    // A server returning 5xx is under load, misconfigured or mid-deploy — the
    // exact moment a crawler does the most damage by continuing. And "we could
    // not read robots.txt" is not "robots.txt permits this".
    const state = await fetchRobots(network({ status }), ORIGIN);

    expect(state.outcome).toBe('unavailable');
    expect(state.siteDisallowed).toBe(true);
  });

  it.each([401, 403])('%i disallows the entire site', async (status) => {
    // A server that authenticates its robots.txt is telling us we are not an
    // audience for its rules.
    const state = await fetchRobots(network({ status }), ORIGIN);

    expect(state.outcome).toBe('forbidden');
    expect(state.siteDisallowed).toBe(true);
  });

  it.each([
    'connect_timeout',
    'headers_timeout',
    'body_timeout',
    'tls_error',
    'connect_failed',
  ] as const)('a %s disallows the entire site', async (failure) => {
    const state = await fetchRobots(
      network({ status: 0, failure: new TransportError(failure, failure) }),
      ORIGIN,
    );

    expect(state.outcome).toBe('error');
    expect(state.siteDisallowed).toBe(true);
  });

  it('a name that does not resolve disallows the site', async () => {
    const deps: SafeFetchDependencies = {
      resolver: new FixtureResolver({}),
      transport: new ForbiddenTransport(),
    };

    const state = await fetchRobots(deps, 'https://nowhere.test');

    expect(state.outcome).toBe('error');
    expect(state.siteDisallowed).toBe(true);
  });

  it('⚠️ an SSRF refusal disallows the site, without a socket', async () => {
    // A site whose robots.txt resolves to a private address is not a site we
    // should be crawling the rest of.
    const deps: SafeFetchDependencies = {
      resolver: new FixtureResolver({ 'internal.test': ['10.0.0.1'] }),
      transport: new ForbiddenTransport(),
    };

    const state = await fetchRobots(deps, 'https://internal.test');

    expect(state.outcome).toBe('error');
    expect(state.siteDisallowed).toBe(true);
  });

  it('a response too large disallows rather than proceeding', async () => {
    const deps: SafeFetchDependencies = {
      resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
      transport: new FixtureTransport({
        [ROBOTS_URL]: {
          status: 200,
          chunks: Array.from({ length: 200 }, () => 'x'.repeat(10_000)),
        },
      }),
    };

    const state = await fetchRobots(deps, ORIGIN, { maxBytes: 1024 });

    expect(state.outcome).toBe('error');
    expect(state.siteDisallowed).toBe(true);
  });

  it('says something an operator can act on, and no stack trace', async () => {
    const state = await fetchRobots(network({ status: 503 }), ORIGIN);

    expect(state.detail).toContain('503');
    expect(state.detail).not.toContain('at ');
    expect(state.detail).not.toContain('Error:');
    // The URL is recorded so the crawl is reproducible.
    expect(state.url).toBe(ROBOTS_URL);
  });
});

describe('the request itself', () => {
  it('identifies the bot, with a URL a site owner can look up', async () => {
    const deps = network({ status: 200, body: '' });
    await fetchRobots(deps, ORIGIN);

    const agent = (deps.transport as FixtureTransport).attempts[0]?.headers['user-agent'] ?? '';
    expect(agent).toContain('GrowthOSBot');
    expect(agent).toContain('+https://');
  });

  it('asks for /robots.txt at the origin root, whatever trailing slash it was given', async () => {
    const deps = network({ status: 200, body: '' });
    await fetchRobots(deps, `${ORIGIN}/`);
    expect((deps.transport as FixtureTransport).attempts[0]?.url).toBe(ROBOTS_URL);
  });
});

describe('recovery is per crawl, by decision', () => {
  it('is fetched once per crawl and cached for its lifetime', () => {
    // The part a future contributor would otherwise implement by accident.
    // A crawl whose permission state changed halfway would have fetched some
    // pages under one rule set and some under another, with no honest way to
    // report which. ADR-0035 §recovery.
    expect(robotsCacheScope()).toBe('per_crawl');
  });

  it('a recovered server is read normally by the next fetch — no cooldown', async () => {
    const failing = await fetchRobots(network({ status: 503 }), ORIGIN);
    expect(failing.siteDisallowed).toBe(true);

    const recovered = await fetchRobots(
      network({ status: 200, body: 'User-agent: *\nDisallow: /admin' }),
      ORIGIN,
    );

    // No penalty carried forward: the next crawl is a fresh request on a human
    // timescale, and a cooldown would only keep punishing a site that has
    // already recovered.
    expect(recovered.siteDisallowed).toBe(false);
    expect(recovered.outcome).toBe('fetched');
  });
});
