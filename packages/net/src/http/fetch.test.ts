/**
 * `safeFetch` — the SSRF pipeline, end to end.
 *
 * WHY THIS IS THE MOST IMPORTANT SUITE IN STAGE 4
 * The crawler is a server-side HTTP client pointed at an address a customer
 * typed into a form. Everything else in the stage is data modelling; this is
 * the part where getting it wrong reads a cloud provider's credentials.
 *
 * Two properties are asserted throughout, and the second is the one that is
 * usually missing:
 *
 *   1. the request was REFUSED, and
 *   2. **no socket was opened** — proved by a transport that throws if it is
 *      called at all, or by counting attempts.
 *
 * An implementation that connects and then errors satisfies (1) and has already
 * lost.
 */

import { describe, expect, it } from 'vitest';
import { safeFetch, type SafeFetchDependencies } from './fetch';
import { TransportError } from './transport';
import {
  FixtureResolver,
  FixtureTransport,
  ForbiddenTransport,
  RebindingResolver,
  type FixtureResponse,
} from '../testing/fixtures';

const PUBLIC_IP = '93.184.216.34';

interface FixtureNetwork extends SafeFetchDependencies {
  readonly resolver: FixtureResolver;
  readonly transport: FixtureTransport;
}

function network(
  table: Readonly<Record<string, readonly string[]>>,
  routes: Readonly<Record<string, FixtureResponse>>,
  fallback?: FixtureResponse,
): FixtureNetwork {
  return {
    resolver: new FixtureResolver(table),
    transport: new FixtureTransport(routes, fallback),
  };
}

/**
 * A network where nothing may be dialled.
 *
 * `ForbiddenTransport` throws if it is called at all, so a test using this
 * proves "no socket was opened" rather than "an error was returned".
 */
function sealed(table: Readonly<Record<string, readonly string[]>> = {}): SafeFetchDependencies & {
  readonly resolver: FixtureResolver;
} {
  return { resolver: new FixtureResolver(table), transport: new ForbiddenTransport() };
}

// ---------------------------------------------------------------------------

describe('safeFetch — the happy path exists', () => {
  it('fetches an ordinary public page', async () => {
    const deps = network({ 'example.test': [PUBLIC_IP] }, {
      'https://example.test/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><title>Hi</title></html>',
      },
    });

    const outcome = await safeFetch(deps, 'https://example.test/');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe(200);
      expect(outcome.body.toString()).toContain('<title>Hi</title>');
      // ⚠️ The socket went to the address the classifier approved, not to a
      // name the transport resolved for itself.
      expect(outcome.peerAddress).toBe(PUBLIC_IP);
    }
  });

  it('sends the site as the Host header, not the pinned address', async () => {
    // A virtual host serving 400 sites needs to know which one was asked for.
    // Pinning changes where the packets go; it must not change what is asked.
    const deps = network({ 'example.test': [PUBLIC_IP] }, {
      'https://example.test/': { status: 200, body: 'ok' },
    });

    await safeFetch(deps, 'https://example.test/');

    expect(deps.transport.attempts[0]?.headers['host']).toBe('example.test');
  });

  it('never sends a cookie', async () => {
    const deps = network({ 'example.test': [PUBLIC_IP] }, {
      'https://example.test/': { status: 200, body: 'ok' },
    });

    await safeFetch(deps, 'https://example.test/');

    const headers = deps.transport.attempts[0]?.headers ?? {};
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie');
  });
});

// ---------------------------------------------------------------------------

describe('the SSRF matrix — nothing is dialled', () => {
  /**
   * ⚠️ `ForbiddenTransport` THROWS IF IT IS CALLED.
   *
   * So every case below proves the stronger property: not "the fetch returned
   * an error" but "no connection was attempted".
   */
  const literals: readonly (readonly [string, string])[] = [
    ['http://127.0.0.1/', 'loopback'],
    ['http://127.0.0.1:80/admin', 'loopback'],
    ['http://0.0.0.0/', 'this-network'],
    ['http://10.0.0.1/', 'private-a'],
    ['http://172.16.0.1/', 'private-b'],
    ['http://192.168.1.1/', 'private-c'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://100.64.0.1/', 'cgnat'],
    ['http://[::1]/', 'loopback'],
    ['http://[fc00::1]/', 'unique-local'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://[::ffff:127.0.0.1]/', 'loopback'],
    ['http://[::ffff:10.0.0.1]/', 'private-a'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'link-local'],
    // Alternative spellings the URL parser folds into the canonical form.
    ['http://2130706433/', 'loopback'],
    ['http://0177.0.0.1/', 'loopback'],
    ['http://0x7f000001/', 'loopback'],
    ['http://127.1/', 'loopback'],
  ];

  it.each(literals)('refuses %s (%s) without opening a socket', async (url, rule) => {
    const deps = sealed();

    const outcome = await safeFetch(deps, url);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('ssrf_blocked');
      expect(outcome.rule).toBe(rule);
    }
    // And no DNS query either — an IP literal has nothing to resolve.
    expect(deps.resolver.calls).toEqual([]);
  });

  it('refuses the AWS metadata address by its most famous path', async () => {
    const deps = sealed();
    const outcome = await safeFetch(deps, 'http://169.254.169.254/latest/meta-data/iam/');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rule).toBe('link-local');
  });

  describe('hostnames that resolve somewhere private', () => {
    it('refuses a public name pointing at loopback', async () => {
      // The classic: `localtest.me`, `nip.io`, or simply an attacker's own zone.
      const deps = sealed({ 'evil.test': ['127.0.0.1'] });

      const outcome = await safeFetch(deps, 'https://evil.test/');

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure).toBe('ssrf_blocked');
        expect(outcome.rule).toBe('loopback');
      }
      // It DID resolve — that is how it found out — but never dialled.
      expect(deps.resolver.calls).toEqual(['evil.test']);
    });

    it('refuses a name pointing at cloud metadata', async () => {
      const deps = sealed({ 'metadata.evil.test': ['169.254.169.254'] });
      const outcome = await safeFetch(deps, 'https://metadata.evil.test/');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.rule).toBe('link-local');
    });

    it('⚠️ refuses a MIXED answer entirely, rather than picking the public one', async () => {
      // Choosing the public address would be safe for THIS request and would
      // leave a name in the frontier whose next fetch — different ordering, a
      // connection failure and retry — reaches 10.0.0.1.
      const deps = sealed({ 'mixed.test': [PUBLIC_IP, '10.0.0.1'] });

      const outcome = await safeFetch(deps, 'https://mixed.test/');

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.rule).toBe('private-a');
    });

    it('refuses when the private address is listed first', async () => {
      const deps = sealed({ 'mixed.test': ['192.168.0.5', PUBLIC_IP] });
      const outcome = await safeFetch(deps, 'https://mixed.test/');
      expect(outcome.ok).toBe(false);
    });

    it('reports a name that does not resolve as dns_failure, not as blocked', async () => {
      // A different fact, and a different operator action.
      const deps = sealed({});
      const outcome = await safeFetch(deps, 'https://nowhere.test/');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure).toBe('dns_failure');
        expect(outcome.rule).toBe('lookup_failed');
        expect(outcome.detail).toBe('ENOTFOUND');
      }
    });
  });

  describe('DNS rebinding', () => {
    it('⚠️ resolves exactly once, so a changed second answer never happens', async () => {
      // The attack: answer public for the check, private for the connection.
      // A validate-then-fetch implementation calls the resolver twice and
      // connects on the second answer. This one pins after the first.
      const resolver = new RebindingResolver([PUBLIC_IP], ['169.254.169.254']);
      const transport = new FixtureTransport({
        'https://rebind.test/': { status: 200, body: 'ok' },
      });

      const outcome = await safeFetch({ resolver, transport }, 'https://rebind.test/');

      expect(outcome.ok).toBe(true);
      expect(resolver.resolutions).toBe(1);
      // The socket went to the address that was VALIDATED, not to whatever the
      // second lookup would have said.
      expect(transport.connectedAddresses).toEqual([PUBLIC_IP]);
    });

    it('refuses when the FIRST answer is already private', async () => {
      const resolver = new RebindingResolver(['10.0.0.1'], [PUBLIC_IP]);
      const outcome = await safeFetch(
        { resolver, transport: new ForbiddenTransport() },
        'https://rebind.test/',
      );
      expect(outcome.ok).toBe(false);
    });

    it('re-resolves on a redirect, and refuses if that answer is private', async () => {
      // Each hop is a new host and a new lookup. Pinning is per-connection, not
      // per-crawl — a redirect must not inherit the previous hop's approval.
      const resolver = new FixtureResolver({
        'safe.test': [PUBLIC_IP],
        'inner.test': ['10.1.2.3'],
      });
      const transport = new FixtureTransport({
        'https://safe.test/': { status: 302, headers: { location: 'https://inner.test/' } },
      });

      const outcome = await safeFetch({ resolver, transport }, 'https://safe.test/');

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure).toBe('ssrf_blocked');
        expect(outcome.rule).toBe('private-a');
      }
      // One connection: the first hop. The second was never dialled.
      expect(transport.attempts).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------

describe('URL policy applies at every hop', () => {
  it.each([
    ['file:///etc/passwd', 'scheme_not_allowed'],
    ['ftp://example.test/x', 'scheme_not_allowed'],
    ['gopher://example.test:70/_x', 'scheme_not_allowed'],
    ['data:text/html,<b>x</b>', 'scheme_not_allowed'],
    ['https://user:pass@example.test/', 'credentials_present'],
    ['https://example.test:6379/', 'port_not_allowed'],
    ['https://example.test/x?token=abc', 'sensitive_query'],
  ])('refuses %s up front', async (url, failure) => {
    const outcome = await safeFetch(sealed(), url);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe(failure);
  });

  it('⚠️ refuses a redirect to a forbidden SCHEME', async () => {
    const resolver = new FixtureResolver({ 'example.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://example.test/': {
        status: 302,
        headers: { location: 'file:///etc/passwd' },
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://example.test/');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('scheme_not_allowed');
    expect(transport.attempts).toHaveLength(1);
  });

  it('⚠️ refuses a redirect to a forbidden PORT', async () => {
    const resolver = new FixtureResolver({ 'example.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://example.test/': {
        status: 302,
        headers: { location: 'https://example.test:6379/' },
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://example.test/');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('port_not_allowed');
  });

  it('⚠️ refuses a redirect to a private ADDRESS — the headline case', async () => {
    // A perfectly ordinary public URL that answers `302 Location:
    // http://169.254.169.254/`. Any client with automatic redirect following
    // fetches it. This one never opens the socket.
    const resolver = new FixtureResolver({ 'example.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://example.test/': {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://example.test/');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('ssrf_blocked');
      expect(outcome.rule).toBe('link-local');
      expect(outcome.redirects).toHaveLength(1);
    }
    expect(transport.attempts).toHaveLength(1);
    expect(transport.connectedAddresses).toEqual([PUBLIC_IP]);
  });

  it('refuses a redirect chain that reaches a private address on the fifth hop', async () => {
    const resolver = new FixtureResolver({
      'a.test': [PUBLIC_IP],
      'b.test': [PUBLIC_IP],
      'c.test': [PUBLIC_IP],
      'd.test': ['10.0.0.9'],
    });
    const transport = new FixtureTransport({
      'https://a.test/': { status: 301, headers: { location: 'https://b.test/' } },
      'https://b.test/': { status: 302, headers: { location: 'https://c.test/' } },
      'https://c.test/': { status: 307, headers: { location: 'https://d.test/' } },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://a.test/');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rule).toBe('private-a');
  });
});

// ---------------------------------------------------------------------------

describe('redirects', () => {
  it('follows an ordinary chain and reports every hop', async () => {
    const resolver = new FixtureResolver({ 'example.test': [PUBLIC_IP], 'www.example.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'http://example.test/': { status: 301, headers: { location: 'https://example.test/' } },
      'https://example.test/': {
        status: 301,
        headers: { location: 'https://www.example.test/' },
      },
      'https://www.example.test/': { status: 200, body: 'arrived' },
    });

    const outcome = await safeFetch({ resolver, transport }, 'http://example.test/');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.url).toBe('https://www.example.test/');
      expect(outcome.requestedUrl).toBe('http://example.test/');
      expect(outcome.redirects.map((hop) => hop.status)).toEqual([301, 301]);
    }
  });

  it('resolves a relative Location against the CURRENT url', async () => {
    const resolver = new FixtureResolver({ 'example.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://example.test/a/b': { status: 302, headers: { location: '../c' } },
      'https://example.test/c': { status: 200, body: 'ok' },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://example.test/a/b');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.url).toBe('https://example.test/c');
  });

  it('stops at the redirect limit rather than looping forever', async () => {
    const resolver = new FixtureResolver({ 'loop.test': [PUBLIC_IP] });
    const transport = new FixtureTransport(
      {},
      { status: 302, headers: { location: 'https://loop.test/next' } },
    );

    const outcome = await safeFetch({ resolver, transport }, 'https://loop.test/');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('redirect_limit');
    // Six connections: the original plus five hops. Bounded, and the bound is
    // the configured one.
    expect(transport.attempts).toHaveLength(6);
  });

  it('honours a caller-supplied scope check — where crawl scope lives', async () => {
    const resolver = new FixtureResolver({ 'example.test': [PUBLIC_IP], 'other.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://example.test/': { status: 302, headers: { location: 'https://other.test/' } },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://example.test/', {
      allowRedirect: (_from, to) => to.origin === 'https://example.test',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('redirect_refused');
      expect(outcome.rule).toBe('out_of_scope');
    }
    expect(transport.attempts).toHaveLength(1);
  });

  it('refuses a 3xx with no Location rather than treating it as a page', async () => {
    const resolver = new FixtureResolver({ 'example.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://example.test/': { status: 302, headers: {} },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://example.test/');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rule).toBe('redirect_without_location');
  });
});

// ---------------------------------------------------------------------------

describe('response limits', () => {
  it('refuses a body over the compressed cap, mid-stream', async () => {
    const resolver = new FixtureResolver({ 'big.test': [PUBLIC_IP] });
    // Twenty 1 KB chunks against a 4 KB cap: the limit must bite on the fifth,
    // not after all twenty have been buffered.
    const transport = new FixtureTransport({
      'https://big.test/': {
        status: 200,
        chunks: Array.from({ length: 20 }, () => 'x'.repeat(1024)),
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://big.test/', {
      limits: { maxCompressedBytes: 4096 },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('response_too_large');
      expect(outcome.rule).toBe('compressed');
    }
  });

  it('refuses early on a Content-Length that is over the cap', async () => {
    const resolver = new FixtureResolver({ 'big.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://big.test/': {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': '999999999' },
        body: 'x',
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://big.test/', {
      limits: { maxCompressedBytes: 1024 },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rule).toBe('content_length');
  });

  it('⚠️ refuses a compression bomb on the DECOMPRESSED cap', async () => {
    // 100 MB of zeroes gzips to a few hundred KB. A single limit on the
    // compressed size is not a limit at all — this is why there are two.
    const { gzipSync } = await import('node:zlib');
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0));

    const resolver = new FixtureResolver({ 'bomb.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://bomb.test/': {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: bomb,
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://bomb.test/', {
      limits: { maxCompressedBytes: 2 * 1024 * 1024, maxDecompressedBytes: 1024 * 1024 },
    });

    // The compressed stream is well under its cap — that is the trap.
    expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('response_too_large');
      expect(outcome.rule).toBe('decompressed');
    }
  });

  it('decompresses an honest gzip body', async () => {
    const { gzipSync } = await import('node:zlib');
    const resolver = new FixtureResolver({ 'gz.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://gz.test/': {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: gzipSync(Buffer.from('<html>hello</html>')),
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://gz.test/');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.body.toString()).toBe('<html>hello</html>');
  });

  it('refuses an unsupported content type BEFORE reading the body', async () => {
    const resolver = new FixtureResolver({ 'video.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://video.test/clip.mp4': {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
        chunks: Array.from({ length: 100 }, () => 'x'.repeat(1024)),
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://video.test/clip.mp4', {
      acceptContentTypes: ['text/html', 'application/xhtml+xml'],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('unsupported_content_type');
      expect(outcome.rule).toBe('video/mp4');
    }
  });

  it('matches a content type ignoring its parameters', async () => {
    const resolver = new FixtureResolver({ 'x.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://x.test/': {
        status: 200,
        headers: { 'content-type': 'TEXT/HTML; charset=UTF-8' },
        body: 'ok',
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://x.test/', {
      acceptContentTypes: ['text/html'],
    });
    expect(outcome.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('transport failures become typed categories', () => {
  it.each([
    ['connect_timeout'],
    ['headers_timeout'],
    ['body_timeout'],
    ['tls_error'],
    ['connect_failed'],
  ] as const)('%s', async (failure) => {
    const resolver = new FixtureResolver({ 'slow.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://slow.test/': { status: 0, failure: new TransportError(failure, failure) },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://slow.test/');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe(failure);
  });

  it('never leaks a stack trace into the detail', async () => {
    const resolver = new FixtureResolver({ 'x.test': [PUBLIC_IP] });
    const transport = new FixtureTransport({
      'https://x.test/': {
        status: 0,
        failure: new TransportError('tls_error', 'CERT_HAS_EXPIRED'),
      },
    });

    const outcome = await safeFetch({ resolver, transport }, 'https://x.test/');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toBe('CERT_HAS_EXPIRED');
      expect(outcome.detail).not.toContain('at ');
    }
  });
});
