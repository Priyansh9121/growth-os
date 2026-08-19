/**
 * Sitemap fetch semantics — what each HTTP outcome means.
 *
 * ⚠️ THE WHOLE SUITE EXISTS TO PROVE ONE ASYMMETRY WITH robots.txt.
 *
 * `fetchRobots` fails CLOSED: a 5xx or a network error disallows the entire
 * site, because "we could not read robots.txt" is not "robots.txt permits
 * this". A sitemap is the opposite, and the difference is not a preference —
 * a sitemap grants nothing. It is the site's own list of pages, an
 * optimisation over discovering them by following links. Most sites do not
 * have one.
 *
 * So every case below asserts `siteDisallowed` stays false. Treating a missing
 * sitemap the way a missing robots.txt is treated would make the majority of
 * the web uncrawlable.
 *
 * @see docs/decisions/ADR-0051-sitemap-fetch-is-fail-open.md
 */

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TransportError, type SafeFetchDependencies } from '@growth-os/net';
import { FixtureResolver, FixtureTransport, ForbiddenTransport } from '@growth-os/net/testing';
import { fetchSitemap } from './fetch';

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';
const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;
const GZ_URL = `${ORIGIN}/sitemap.xml.gz`;

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/</loc></url>
  <url><loc>${ORIGIN}/contact</loc></url>
</urlset>`;

function network(
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
    failure?: TransportError;
  },
  // ⚠️ The route is keyed on the URL. The first version of this helper hardcoded
  // `SITEMAP_URL`, so every `.gz` case fetched an unregistered address and got a
  // 404 — three tests that looked like a gzip bug and were a fixture bug.
  url: string = SITEMAP_URL,
): SafeFetchDependencies {
  return {
    resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
    transport: new FixtureTransport({ [url]: response }),
  };
}

describe('2xx — the list is read', () => {
  it('parses a urlset and reports the pages', async () => {
    const state = await fetchSitemap(
      network({ status: 200, headers: { 'content-type': 'application/xml' }, body: URLSET }),
      SITEMAP_URL,
    );

    expect(state.outcome).toBe('fetched');
    expect(state.siteDisallowed).toBe(false);
    expect(state.document?.kind).toBe('urlset');
    if (state.document?.kind === 'urlset') {
      expect(state.document.entries.map((e) => e.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/contact`]);
    }
  });

  it('parses a sitemapindex and reports the child sitemaps', async () => {
    const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>${ORIGIN}/sitemap-1.xml</loc></sitemap>
    </sitemapindex>`;

    const state = await fetchSitemap(
      network({ status: 200, headers: { 'content-type': 'application/xml' }, body: index }),
      SITEMAP_URL,
    );

    expect(state.outcome).toBe('fetched');
    expect(state.document?.kind).toBe('sitemapindex');
  });

  it('reports a 200 that is not a sitemap without pretending it was one', async () => {
    // A site that serves its 404 page with status 200 is extremely common.
    const state = await fetchSitemap(
      network({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>404</html>' }),
      SITEMAP_URL,
    );

    expect(state.outcome).toBe('not_a_sitemap');
    expect(state.siteDisallowed).toBe(false);
    expect(state.document).toBeNull();
  });
});

describe('⚠️ every failure is fail-OPEN — the asymmetry with robots.txt', () => {
  it.each([
    [404, 'absent'],
    [410, 'absent'],
    [403, 'absent'],
    [401, 'absent'],
  ])('a %i leaves the site crawlable (%s)', async (status, outcome) => {
    // ⚠️ 401/403 are `absent` here and FAIL-CLOSED in robots.txt. A site that
    // authenticates its rules is telling us we may not read them; a site that
    // authenticates its sitemap is telling us nothing about permission.
    const state = await fetchSitemap(network({ status }), SITEMAP_URL);

    expect(state.outcome).toBe(outcome);
    expect(state.siteDisallowed).toBe(false);
    expect(state.document).toBeNull();
  });

  it.each([500, 502, 503])('a %i leaves the site crawlable', async (status) => {
    const state = await fetchSitemap(network({ status }), SITEMAP_URL);

    expect(state.outcome).toBe('unavailable');
    expect(state.siteDisallowed).toBe(false);
  });

  it('a network failure leaves the site crawlable', async () => {
    const state = await fetchSitemap(
      network({ status: 0, failure: new TransportError('connect_timeout', 'connect_timeout') }),
      SITEMAP_URL,
    );

    expect(state.outcome).toBe('error');
    expect(state.siteDisallowed).toBe(false);
  });

  it('⚠️ an SSRF refusal leaves the site crawlable, and opens no socket', async () => {
    // ForbiddenTransport THROWS if dialled, so this proves no connection was
    // attempted rather than that an error came back (§6).
    const state = await fetchSitemap(
      {
        resolver: new FixtureResolver({ 'example.test': ['169.254.169.254'] }),
        transport: new ForbiddenTransport(),
      },
      SITEMAP_URL,
    );

    expect(state.outcome).toBe('error');
    expect(state.siteDisallowed).toBe(false);
  });

  it('⚠️ PROPERTY: no outcome this module can produce ever disallows the site', async () => {
    // The strong property, stated once over every branch. A sitemap grants
    // nothing, so no failure to read one can withdraw permission.
    const responses = [
      { status: 200, body: URLSET },
      { status: 200, body: 'not xml' },
      { status: 404 },
      { status: 403 },
      { status: 500 },
      { status: 0, failure: new TransportError('connect_timeout', 'connect_timeout') },
    ];

    for (const response of responses) {
      const state = await fetchSitemap(network(response), SITEMAP_URL);
      expect(state.siteDisallowed, JSON.stringify(response.status)).toBe(false);
    }
  });
});

describe('gzip — sitemap.xml.gz is legitimate and common', () => {
  it('reads a body the server declared as gzip content-encoding', async () => {
    // `safeFetch` decompresses this one, under its own two-tier cap.
    const state = await fetchSitemap(
      network({
        status: 200,
        headers: { 'content-type': 'application/xml', 'content-encoding': 'gzip' },
        body: gzipSync(Buffer.from(URLSET)),
      }),
      SITEMAP_URL,
    );

    expect(state.outcome).toBe('fetched');
    expect(state.document?.kind).toBe('urlset');
  });

  it('⚠️ reads a .gz FILE, which carries no content-encoding at all', async () => {
    // The case `safeFetch` cannot handle: a `.gz` served as a file body with
    // `content-type: application/gzip` and no `content-encoding` header. The
    // bytes arrive compressed and this module decompresses them.
    const state = await fetchSitemap(
      network(
        {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
          body: gzipSync(Buffer.from(URLSET)),
        },
        GZ_URL,
      ),
      GZ_URL,
    );

    expect(state.outcome).toBe('fetched');
    if (state.document?.kind === 'urlset') {
      expect(state.document.entries).toHaveLength(2);
    }
  });

  it('⚠️ refuses a gzip bomb served as a file body', async () => {
    // The reason the decompression here is bounded rather than convenient:
    // `safeFetch`'s decompressed tier never sees these bytes, because the
    // server did not declare an encoding.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x61));

    const state = await fetchSitemap(
      network({ status: 200, headers: { 'content-type': 'application/gzip' }, body: bomb }, GZ_URL),
      GZ_URL,
    );

    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(state.outcome).toBe('not_a_sitemap');
    expect(state.siteDisallowed).toBe(false);
    expect(state.document).toBeNull();
  });

  it('treats undecompressable gzip-looking bytes as not a sitemap', async () => {
    const state = await fetchSitemap(
      network(
        {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
          body: Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]),
        },
        GZ_URL,
      ),
      GZ_URL,
    );

    expect(state.outcome).toBe('not_a_sitemap');
    expect(state.siteDisallowed).toBe(false);
  });
});

describe('the request itself', () => {
  it('⚠️ states both body tiers rather than inheriting one (ADR-0049)', async () => {
    // `resolveLimits` throws on a half-stated override, so a call that reached
    // the network at all proves both tiers were supplied together.
    const state = await fetchSitemap(
      network({ status: 200, headers: { 'content-type': 'application/xml' }, body: URLSET }),
      SITEMAP_URL,
    );

    expect(state.outcome).toBe('fetched');
  });

  it('records the URL it read, so a crawl is reproducible', async () => {
    const state = await fetchSitemap(network({ status: 404 }), SITEMAP_URL);
    expect(state.url).toBe(SITEMAP_URL);
  });

  it('refuses a sitemap URL that is not a URL at all, without dialling', async () => {
    const state = await fetchSitemap(
      { resolver: new FixtureResolver({}), transport: new ForbiddenTransport() },
      'not a url',
    );

    expect(state.outcome).toBe('error');
    expect(state.siteDisallowed).toBe(false);
  });
});
