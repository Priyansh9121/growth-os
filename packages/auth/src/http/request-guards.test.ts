/**
 * HTTP boundary guards: open redirect, CSRF origin, client IP.
 *
 * Each case here corresponds to a specific documented attack. Where a payload
 * looks strange, the comment says which browser or parser behaviour makes it
 * dangerous.
 *
 * @see docs/security/threat-model.md
 */

import { describe, expect, it } from 'vitest';
import {
  extractClientIp,
  isTrustedOrigin,
  normaliseUserAgent,
  sanitiseRedirect,
} from './request-guards';

describe('sanitiseRedirect — open redirect defence', () => {
  it('accepts a same-origin relative path', () => {
    expect(sanitiseRedirect('/dashboard')).toBe('/dashboard');
    expect(sanitiseRedirect('/seo/keywords?sort=volume')).toBe('/seo/keywords?sort=volume');
  });

  it('rejects an absolute URL to another origin', () => {
    // The core attack: /login?next=https://evil.example makes OUR domain
    // bounce a freshly-authenticated user to a credential-harvesting page.
    expect(sanitiseRedirect('https://evil.example')).toBe('/dashboard');
    expect(sanitiseRedirect('http://evil.example/path')).toBe('/dashboard');
  });

  it('rejects a protocol-relative URL', () => {
    // `//evil.example` has no scheme, so it reads as a relative path to a
    // naive check — but the browser resolves it as a HOST.
    expect(sanitiseRedirect('//evil.example')).toBe('/dashboard');
    expect(sanitiseRedirect('//evil.example/dashboard')).toBe('/dashboard');
  });

  it('rejects backslash variants', () => {
    // Some parsers and browsers normalise `\` to `/`, so `/\evil.example`
    // becomes `//evil.example` — the protocol-relative attack in disguise.
    expect(sanitiseRedirect('/\\evil.example')).toBe('/dashboard');
    expect(sanitiseRedirect('/path\\to')).toBe('/dashboard');
  });

  it('rejects URL-encoded payloads', () => {
    // %2f%2f decodes to // — a check that runs before decoding would pass this.
    expect(sanitiseRedirect('%2f%2fevil.example')).toBe('/dashboard');
    expect(sanitiseRedirect('%2F%2Fevil.example')).toBe('/dashboard');
  });

  it('rejects scheme injection', () => {
    expect(sanitiseRedirect('javascript:alert(1)')).toBe('/dashboard');
    expect(sanitiseRedirect('data:text/html,<script>alert(1)</script>')).toBe('/dashboard');
  });

  it('rejects control characters (response splitting)', () => {
    // CR/LF in a value echoed into a Location header lets an attacker inject
    // their own headers or a second response.
    expect(sanitiseRedirect('/dashboard\r\nSet-Cookie: gos_session=stolen')).toBe('/dashboard');
    expect(sanitiseRedirect('/dashboard\nX-Injected: 1')).toBe('/dashboard');
  });

  it('rejects malformed percent-encoding rather than throwing', () => {
    expect(sanitiseRedirect('%E0%A4%A')).toBe('/dashboard');
  });

  it('falls back when absent', () => {
    expect(sanitiseRedirect(null)).toBe('/dashboard');
    expect(sanitiseRedirect(undefined)).toBe('/dashboard');
    expect(sanitiseRedirect('')).toBe('/dashboard');
  });

  it('honours a custom fallback', () => {
    expect(sanitiseRedirect('https://evil.example', '/login')).toBe('/login');
  });
});

describe('isTrustedOrigin — CSRF defence', () => {
  const appUrl = 'https://app.growthos.test';

  it('accepts a matching Origin', () => {
    expect(isTrustedOrigin('https://app.growthos.test', null, appUrl)).toBe(true);
  });

  it('rejects a different origin', () => {
    expect(isTrustedOrigin('https://evil.example', null, appUrl)).toBe(false);
  });

  it('rejects a different scheme on the same host', () => {
    // http → https is a different origin, and accepting it would permit a
    // network attacker on plain HTTP to forge state-changing requests.
    expect(isTrustedOrigin('http://app.growthos.test', null, appUrl)).toBe(false);
  });

  it('rejects a subdomain', () => {
    expect(isTrustedOrigin('https://evil.app.growthos.test', null, appUrl)).toBe(false);
  });

  it('rejects a suffix-matching lookalike host', () => {
    // Guards against an implementation using endsWith().
    expect(isTrustedOrigin('https://notapp.growthos.test', null, appUrl)).toBe(false);
    expect(isTrustedOrigin('https://app.growthos.test.evil.example', null, appUrl)).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(isTrustedOrigin(null, 'https://app.growthos.test/login', appUrl)).toBe(true);
    expect(isTrustedOrigin(null, 'https://evil.example/login', appUrl)).toBe(false);
  });

  it('FAILS CLOSED when both headers are missing', () => {
    // Browsers send Origin on cross-origin requests and on same-origin POSTs.
    // A state-changing request with neither header is anomalous, and treating
    // "absent" as "safe" is how origin checks get bypassed in practice.
    expect(isTrustedOrigin(null, null, appUrl)).toBe(false);
    expect(isTrustedOrigin(undefined, undefined, appUrl)).toBe(false);
  });

  it('rejects a malformed origin rather than throwing', () => {
    expect(isTrustedOrigin('not-a-url', null, appUrl)).toBe(false);
  });
});

describe('extractClientIp', () => {
  function headers(map: Record<string, string>) {
    return { get: (name: string) => map[name.toLowerCase()] ?? null };
  }

  it('IGNORES X-Forwarded-For when no proxy is trusted', () => {
    // Unconditionally trusting this header makes per-IP rate limiting
    // bypassable with a single request header — worse than having no limit,
    // because it looks like a control that does not exist.
    const result = extractClientIp(headers({ 'x-forwarded-for': '1.2.3.4' }), '10.0.0.1', false);
    expect(result).toBe('10.0.0.1');
  });

  it('honours X-Forwarded-For behind a trusted proxy', () => {
    const result = extractClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), null, true);
    // Leftmost: proxies append, so the first entry is the original client.
    expect(result).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip behind a trusted proxy', () => {
    expect(extractClientIp(headers({ 'x-real-ip': '5.6.7.8' }), null, true)).toBe('5.6.7.8');
  });

  it('returns a stable sentinel when nothing is known', () => {
    // Never undefined: the rate limiter needs a key, and an undefined key
    // would silently disable per-IP limiting.
    expect(extractClientIp(headers({}), null, false)).toBe('unknown');
  });
});

describe('normaliseUserAgent', () => {
  it('truncates attacker-controlled input', () => {
    // Unbounded input in a database column is a denial-of-service vector.
    expect(normaliseUserAgent('x'.repeat(2000))?.length).toBe(512);
  });

  it('returns undefined when absent', () => {
    expect(normaliseUserAgent(null)).toBeUndefined();
    expect(normaliseUserAgent('')).toBeUndefined();
  });
});
