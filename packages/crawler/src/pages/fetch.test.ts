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

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';
const PAGE = `${ORIGIN}/contact`;

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
    const observation = await fetchPage(
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
    const observation = await fetchPage(
      network({ status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }),
      PAGE,
    );

    expect(observation.contentType).toBe('text/html');
  });

  it('records the bytes accepted, as an operational cost signal', async () => {
    const body = 'x'.repeat(2048);
    const observation = await fetchPage(
      network({ status: 200, headers: { 'content-type': 'text/html' }, body }),
      PAGE,
    );

    expect(observation.bytes).toBe(2048);
  });

  it('records last-modified when the server sends it', async () => {
    const observation = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'text/html', 'last-modified': 'Wed, 19 Aug 2026 00:00:00 GMT' },
      }),
      PAGE,
    );

    expect(observation.lastModified).toBe('Wed, 19 Aug 2026 00:00:00 GMT');
  });

  it('leaves conditional-request facts null when absent', async () => {
    const observation = await fetchPage(
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
    const observation = await fetchPage(network({ status }), PAGE);
    expect(observation.outcome).toBe(expected);
  });

  it('a 4xx carries http_4xx as its failure category', async () => {
    const observation = await fetchPage(network({ status: 404 }), PAGE);
    expect(observation.failureCategory).toBe('http_4xx');
  });

  it('a 5xx carries http_5xx as its failure category', async () => {
    const observation = await fetchPage(network({ status: 500 }), PAGE);
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
    const observation = await fetchPage(
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
    const observation = await fetchPage(
      network({ status: 0, failure: new TransportError('connect_timeout', 'connect_timeout') }),
      PAGE,
    );

    expect(observation.outcome).toBe('failed');
    expect(observation.failureCategory).toBe('connect_timeout');
  });

  it('a body over the cap is blocked by response policy, not called a failure', async () => {
    const observation = await fetchPage(
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
    const observation = await fetchPage(
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

    const observation = await fetchPage(net, PAGE);

    expect(observation.outcome).toBe('fetched');
    expect(observation.finalUrl).toBe(`${ORIGIN}/contact-us`);
    expect(observation.redirectCount).toBe(1);
  });

  it('leaves finalUrl null when nothing redirected', async () => {
    const observation = await fetchPage(
      network({ status: 200, headers: { 'content-type': 'text/html' } }),
      PAGE,
    );

    expect(observation.finalUrl).toBeNull();
    expect(observation.redirectCount).toBe(0);
  });
});

describe('⚠️ fetchPage — what it does NOT do', () => {
  it('does not parse the body, extract links, or interpret content', async () => {
    // HTML extraction is a separate brief. A page fetch produces facts about
    // the RESPONSE; what the document says is Stage 5's and the extractor's.
    const observation = await fetchPage(
      network({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><a href="/a">x</a><title>T</title></html>',
      }),
      PAGE,
    );

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
});
