/**
 * Fetching one page — the first page-fetch path in the crawler.
 *
 * ⚠️ IT RECORDS FACTS AND NOTHING ELSE (§5). A status, a content type, a
 * duration, a byte count. Never "this page looks broken", never a severity.
 * Stage 5 reads these and produces findings; this only observes.
 *
 * @see docs/decisions/ADR-0053-the-crawl-run.md
 */

import { describe, expect, it } from 'vitest';
import { TransportError, type SafeFetchDependencies } from '@growth-os/net';
import { FixtureResolver, FixtureTransport, ForbiddenTransport } from '@growth-os/net/testing';
import { fetchPage } from './fetch';
import { crawlScope } from '../urls/scope';

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';
const PAGE = `${ORIGIN}/contact`;
const SCOPE = crawlScope(ORIGIN);

function network(response: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  failure?: TransportError;
}): SafeFetchDependencies {
  return {
    resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
    transport: new FixtureTransport({ [PAGE]: response }),
  };
}

describe('fetchPage — the response facts', () => {
  it('records a successful fetch', async () => {
    const { observation } = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', etag: 'W/"abc"' },
        body: '<html><title>Contact</title></html>',
      }),
      PAGE,
    );

    expect(observation.outcome).toBe('fetched');
    expect(observation.httpStatus).toBe(200);
    expect(observation.contentType).toBe('text/html');
    expect(observation.etag).toBe('W/"abc"');
    expect(observation.failureCategory).toBeNull();
  });

  it('strips content-type parameters, keeping the media type', async () => {
    const { observation } = await fetchPage(
      network({ status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }),
      PAGE,
    );

    expect(observation.contentType).toBe('text/html');
  });

  it('records the bytes accepted, as an operational cost signal', async () => {
    const body = 'x'.repeat(2048);
    const { observation } = await fetchPage(
      network({ status: 200, headers: { 'content-type': 'text/html' }, body }),
      PAGE,
    );

    expect(observation.bytes).toBe(2048);
  });

  it('records last-modified when the server sends it', async () => {
    const { observation } = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'text/html', 'last-modified': 'Wed, 19 Aug 2026 00:00:00 GMT' },
      }),
      PAGE,
    );

    expect(observation.lastModified).toBe('Wed, 19 Aug 2026 00:00:00 GMT');
  });

  it('leaves conditional-request facts null when absent', async () => {
    const { observation } = await fetchPage(
      network({ status: 200, headers: { 'content-type': 'text/html' } }),
      PAGE,
    );

    expect(observation.etag).toBeNull();
    expect(observation.lastModified).toBeNull();
  });
});

describe('fetchPage — the outcome for each status class', () => {
  it.each([
    [200, 'fetched'],
    [204, 'fetched'],
    [404, 'http_4xx'],
    [410, 'http_4xx'],
    [500, 'http_5xx'],
    [503, 'http_5xx'],
  ])('a %i is recorded as %s', async (status, expected) => {
    const { observation } = await fetchPage(network({ status }), PAGE);
    expect(observation.outcome).toBe(expected);
  });

  it('a 4xx carries http_4xx as its failure category', async () => {
    const { observation } = await fetchPage(network({ status: 404 }), PAGE);
    expect(observation.failureCategory).toBe('http_4xx');
  });

  it('a 5xx carries http_5xx as its failure category', async () => {
    const { observation } = await fetchPage(network({ status: 500 }), PAGE);
    expect(observation.failureCategory).toBe('http_5xx');
  });
});

describe('⚠️ fetchPage — refusals go through the same pipeline as every other fetch', () => {
  it('⚠️ an SSRF refusal is blocked, and no socket is opened', async () => {
    // ForbiddenTransport THROWS if dialled. This is the strong property (§6):
    // not "an error came back" but "no connection was attempted".
    //
    // ⚠️ AND IT PROVES THE HOP RUNS AT FETCH TIME. This URL passed frontier
    // admission once already; admission and fetch-time SSRF are different hops
    // and both must run, because DNS can resolve differently between them.
    const { observation } = await fetchPage(
      {
        resolver: new FixtureResolver({ 'example.test': ['169.254.169.254'] }),
        transport: new ForbiddenTransport(),
      },
      PAGE,
    );

    expect(observation.outcome).toBe('blocked');
    expect(observation.failureCategory).toBe('ssrf_blocked');
    expect(observation.httpStatus).toBeNull();
  });

  it('a transport failure is recorded as failed, with its category', async () => {
    const { observation } = await fetchPage(
      network({ status: 0, failure: new TransportError('connect_timeout', 'connect_timeout') }),
      PAGE,
    );

    expect(observation.outcome).toBe('failed');
    expect(observation.failureCategory).toBe('connect_timeout');
  });

  it('a body over the cap is blocked by response policy, not called a failure', async () => {
    const { observation } = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: 'x'.repeat(3 * 1024 * 1024),
      }),
      PAGE,
      { maxCompressedBytes: 64 * 1024 },
    );

    expect(observation.outcome).toBe('blocked');
    expect(observation.failureCategory).toBe('response_too_large');
  });

  it('a URL that is not a URL is blocked without dialling', async () => {
    const { observation } = await fetchPage(
      { resolver: new FixtureResolver({}), transport: new ForbiddenTransport() },
      'not a url',
    );

    expect(observation.outcome).toBe('blocked');
    expect(observation.httpStatus).toBeNull();
  });
});

describe('fetchPage — redirects', () => {
  it('records the final URL and how many hops it took', async () => {
    const net: SafeFetchDependencies = {
      resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
      transport: new FixtureTransport({
        [PAGE]: { status: 301, headers: { location: `${ORIGIN}/contact-us` } },
        [`${ORIGIN}/contact-us`]: {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: 'ok',
        },
      }),
    };

    const { observation } = await fetchPage(net, PAGE);

    expect(observation.outcome).toBe('fetched');
    expect(observation.finalUrl).toBe(`${ORIGIN}/contact-us`);
    expect(observation.redirectCount).toBe(1);
  });

  it('leaves finalUrl null when nothing redirected', async () => {
    const { observation } = await fetchPage(
      network({ status: 200, headers: { 'content-type': 'text/html' } }),
      PAGE,
    );

    expect(observation.finalUrl).toBeNull();
    expect(observation.redirectCount).toBe(0);
  });
});

describe('⚠️ fetchPage — what it does NOT do', () => {
  /**
   * ⚠️ THIS TEST'S SUBJECT CHANGED, AND IT MATTERS MORE NOW, NOT LESS.
   *
   * It used to assert that the module parsed nothing at all. The module now
   * extracts links — but into `PageState.links`, a SIBLING of the observation.
   * The observation's exact key set is what `markFetched` spreads straight into
   * `crawl_pages`, so a stray field here is an insert against a column that
   * does not exist. This is the assertion that catches that.
   */
  it('keeps the observation spreadable — exactly the crawl_pages fields, and no document', async () => {
    const { observation } = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><a href="/a">x</a><title>T</title></html>',
      }),
      PAGE,
      { scope: SCOPE },
    );

    // Even with extraction ON, links are NOT on the observation.
    expect(observation).not.toHaveProperty('links');
    expect(observation).not.toHaveProperty('title');
    expect(observation).not.toHaveProperty('severity');
    expect(Object.keys(observation).sort()).toEqual([
      'bytes',
      'contentLength',
      'contentType',
      'etag',
      'failureCategory',
      'fetchDurationMs',
      'finalUrl',
      'httpStatus',
      'lastModified',
      'outcome',
      'redirectCount',
    ]);
  });

  it('never returns the body, however it is asked', async () => {
    // The document is an argument to the extractor, never a return value.
    // Nothing downstream can persist raw HTML because nothing downstream has it.
    const state = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><a href="/a">x</a></html>',
      }),
      PAGE,
      { scope: SCOPE },
    );

    expect(Object.keys(state).sort()).toEqual(['links', 'observation']);
    expect(JSON.stringify(state)).not.toContain('<html>');
  });
});

describe('⚠️ fetchPage — link extraction', () => {
  const html = (body: string) => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
  });

  it('extracts links when a scope is supplied', async () => {
    const { links } = await fetchPage(
      network(html('<a href="/about">About</a><a href="https://other.test/x">Out</a>')),
      PAGE,
      { scope: SCOPE },
    );

    expect(links.map((l) => l.targetUrl)).toEqual([
      'https://example.test/about',
      'https://other.test/x',
    ]);
    expect(links.map((l) => l.scope)).toEqual(['internal', 'external']);
  });

  it('⚠️ extracts NOTHING when no scope is supplied — parsing is opt-in', async () => {
    const { links } = await fetchPage(network(html('<a href="/about">About</a>')), PAGE);
    expect(links).toEqual([]);
  });

  it('⚠️ does not scan a non-HTML body, even one full of hrefs', async () => {
    // A PDF is still FETCHED and still recorded — the content type gates
    // parsing, not fetching. Scanning it would be noise, not danger.
    const { observation, links } = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: '<a href="/not-really-a-link">x</a>',
      }),
      PAGE,
      { scope: SCOPE },
    );

    expect(observation.outcome).toBe('fetched');
    expect(observation.contentType).toBe('application/pdf');
    expect(links).toEqual([]);
  });

  it('accepts application/xhtml+xml as a document', async () => {
    const { links } = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'application/xhtml+xml' },
        body: '<a href="/about">About</a>',
      }),
      PAGE,
      { scope: SCOPE },
    );

    expect(links.map((l) => l.targetUrl)).toEqual(['https://example.test/about']);
  });

  it('a missing content-type is not treated as HTML', async () => {
    // ⚠️ `headers: {}` is deliberate and not the same as omitting `headers`.
    // FixtureTransport substitutes `text/html; charset=utf-8` when the field is
    // absent (packages/net/src/testing/fixtures.ts:168), so omitting it would
    // test the opposite of what this asserts. Found by this test failing.
    const { observation, links } = await fetchPage(
      network({ status: 200, headers: {}, body: '<a href="/about">About</a>' }),
      PAGE,
      { scope: SCOPE },
    );

    expect(observation.contentType).toBeNull();
    expect(links).toEqual([]);
  });

  it('⚠️ resolves relative links against the FINAL url, not the requested one', async () => {
    // The document came from /moved/here. A relative href in it means
    // /moved/there — resolving against the requested /contact would invent a
    // URL the site never linked to, on every redirected page.
    const net: SafeFetchDependencies = {
      resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
      transport: new FixtureTransport({
        [PAGE]: { status: 301, headers: { location: `${ORIGIN}/moved/here` } },
        [`${ORIGIN}/moved/here`]: html('<a href="there">There</a>'),
      }),
    };

    const { observation, links } = await fetchPage(net, PAGE, { scope: SCOPE });

    expect(observation.finalUrl).toBe(`${ORIGIN}/moved/here`);
    expect(links.map((l) => l.targetUrl)).toEqual(['https://example.test/moved/there']);
  });

  it('a failed fetch yields no links and does not throw', async () => {
    const { observation, links } = await fetchPage(
      network({ status: 0, failure: new TransportError('connect_failed', 'refused') }),
      PAGE,
      { scope: SCOPE },
    );

    expect(observation.outcome).toBe('failed');
    expect(links).toEqual([]);
  });

  it('a 404 body is still scanned — the page exists enough to have links', async () => {
    // A soft-404 that returns 404 with a full navigation is common, and its
    // links are facts about what that document said. Recording them is not the
    // same as deciding they matter (§5).
    const { observation, links } = await fetchPage(
      network({ ...html('<a href="/home">Home</a>'), status: 404 }),
      PAGE,
      { scope: SCOPE },
    );

    expect(observation.outcome).toBe('http_4xx');
    expect(links.map((l) => l.targetUrl)).toEqual(['https://example.test/home']);
  });
});
