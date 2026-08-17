/**
 * URL normalisation — crawl identity.
 *
 * WHY THIS SUITE IS LONG
 * Every case here is a way one page becomes two rows. A crawler that reports
 * 428 pages for a 214-page site is not slightly wrong; every count downstream
 * is wrong, and there is no way to tell from the output which half is real.
 */

import { describe, expect, it } from 'vitest';
import { normaliseUrl, STRIPPED_PARAMETERS, urlDepth } from './normalise';
import { classifyScope, crawlScope, isFetchable, redirectGuard } from './scope';

describe('normaliseUrl', () => {
  describe('the same page, spelled differently', () => {
    const same: readonly (readonly [string, string, string])[] = [
      ['host case', 'https://EXAMPLE.test/about', 'https://example.test/about'],
      ['scheme case', 'HTTPS://example.test/about', 'https://example.test/about'],
      ['default https port', 'https://example.test:443/about', 'https://example.test/about'],
      ['default http port', 'http://example.test:80/about', 'http://example.test/about'],
      ['root-zone dot', 'https://example.test./about', 'https://example.test/about'],
      ['empty path', 'https://example.test', 'https://example.test/'],
      ['dot segment', 'https://example.test/a/./b', 'https://example.test/a/b'],
      ['parent segment', 'https://example.test/a/b/../c', 'https://example.test/a/c'],
      ['fragment', 'https://example.test/about#team', 'https://example.test/about'],
      ['empty fragment', 'https://example.test/about#', 'https://example.test/about'],
      ['unreserved escape', 'https://example.test/a%7Eb', 'https://example.test/a~b'],
      ['escape case', 'https://example.test/a%2fb', 'https://example.test/a%2Fb'],
    ];

    it.each(same)('%s: %s', (_label, input, expected) => {
      expect(normaliseUrl(input)).toBe(expected);
    });

    it('⚠️ collapses every fragment on a page with a table of contents', () => {
      // The single highest-volume duplicate on a documentation site.
      const anchors = ['#intro', '#setup', '#usage', '#faq'].map((hash) =>
        normaliseUrl(`https://example.test/docs${hash}`),
      );
      expect(new Set(anchors).size).toBe(1);
    });
  });

  describe('genuinely different pages', () => {
    const different: readonly (readonly [string, string])[] = [
      ['https://example.test/a', 'https://example.test/b'],
      ['https://example.test/a', 'https://example.test/A'],
      ['https://www.example.test/', 'https://example.test/'],
      ['https://example.test/', 'http://example.test/'],
      ['https://example.test/p?id=1', 'https://example.test/p?id=2'],
      // ⚠️ NOT folded by default. Servers routinely serve different content,
      // and a site that canonicalises one to the other emits a 301 the crawler
      // follows and records — which is how to learn it honestly.
      ['https://example.test/a', 'https://example.test/a/'],
    ];

    it.each(different)('%s ≠ %s', (a, b) => {
      expect(normaliseUrl(a)).not.toBe(normaliseUrl(b));
    });

    it('folds the trailing slash only when asked', () => {
      expect(normaliseUrl('https://example.test/a/', { foldTrailingSlash: true })).toBe(
        'https://example.test/a',
      );
      // Never the root, which has no non-slash form.
      expect(normaliseUrl('https://example.test/', { foldTrailingSlash: true })).toBe(
        'https://example.test/',
      );
    });
  });

  describe('tracking parameters', () => {
    it('strips a full campaign decoration', () => {
      expect(
        normaliseUrl(
          'https://example.test/pricing?utm_source=google&utm_medium=cpc&utm_campaign=spring&gclid=XYZ',
        ),
      ).toBe('https://example.test/pricing');
    });

    it.each(STRIPPED_PARAMETERS.tracking)('strips %s', (name) => {
      expect(normaliseUrl(`https://example.test/p?${name}=value`)).toBe('https://example.test/p');
    });

    it.each(STRIPPED_PARAMETERS.session)('strips the session parameter %s', (name) => {
      // A session id creates a new URL per visitor; keeping them would let one
      // page consume an entire crawl budget.
      expect(normaliseUrl(`https://example.test/p?${name}=abc123`)).toBe('https://example.test/p');
    });

    it('strips regardless of case', () => {
      expect(normaliseUrl('https://example.test/p?UTM_Source=x&PHPSESSID=y')).toBe(
        'https://example.test/p',
      );
    });

    it('keeps meaningful parameters beside stripped ones', () => {
      expect(normaliseUrl('https://example.test/p?id=7&utm_source=google&page=2')).toBe(
        'https://example.test/p?id=7&page=2',
      );
    });

    it('⚠️ does NOT strip every query parameter', () => {
      // The tempting shortcut, and the wrong one: ?product=1234 is a product.
      expect(normaliseUrl('https://example.test/shop?product=1234')).toBe(
        'https://example.test/shop?product=1234',
      );
    });
  });

  describe('query ordering', () => {
    it('sorts parameters, so one request is not two pages', () => {
      expect(normaliseUrl('https://example.test/p?b=2&a=1')).toBe(
        normaliseUrl('https://example.test/p?a=1&b=2'),
      );
    });

    it('preserves the order of repeated names', () => {
      // `?tag=a&tag=b` is not `?tag=b&tag=a` to a server reading the first.
      expect(normaliseUrl('https://example.test/p?tag=a&tag=b')).toBe(
        'https://example.test/p?tag=a&tag=b',
      );
      expect(normaliseUrl('https://example.test/p?tag=b&tag=a')).toBe(
        'https://example.test/p?tag=b&tag=a',
      );
    });

    it('encodes a space consistently', () => {
      expect(normaliseUrl('https://example.test/p?q=red+shoes')).toBe(
        'https://example.test/p?q=red%20shoes',
      );
      expect(normaliseUrl('https://example.test/p?q=red%20shoes')).toBe(
        'https://example.test/p?q=red%20shoes',
      );
    });

    it('drops an empty query rather than leaving a bare "?"', () => {
      expect(normaliseUrl('https://example.test/p?')).toBe('https://example.test/p');
      expect(normaliseUrl('https://example.test/p?utm_source=x')).toBe('https://example.test/p');
    });
  });

  describe('relative resolution', () => {
    const base = 'https://example.test/blog/2026/post';

    it.each([
      ['/about', 'https://example.test/about'],
      ['../index', 'https://example.test/blog/index'],
      ['./sibling', 'https://example.test/blog/2026/sibling'],
      ['sibling', 'https://example.test/blog/2026/sibling'],
      ['//other.test/x', 'https://other.test/x'],
      ['?page=2', 'https://example.test/blog/2026/post?page=2'],
    ])('resolves %s', (href, expected) => {
      expect(normaliseUrl(href, { base })).toBe(expected);
    });

    it('refuses a relative URL with no base rather than guessing', () => {
      expect(normaliseUrl('/about')).toBeNull();
    });
  });

  describe('things that are not pages', () => {
    it.each([
      ['mailto:sam@example.test', 'an email address'],
      ['tel:+61400000000', 'a phone number'],
      ['sms:+61400000000', 'a text message'],
      ['javascript:void(0)', 'a script'],
      ['data:text/html,<b>x</b>', 'inline content'],
      ['ftp://example.test/f', 'not the web'],
      ['#section', 'the current page'],
      ['', 'nothing'],
      ['   ', 'whitespace'],
      ['https://', 'no host'],
    ])('%s is not a crawlable URL (%s)', (input) => {
      expect(normaliseUrl(input, { base: 'https://example.test/' })).toBeNull();
    });

    it('⚠️ treats an arbitrary string WITH A BASE as a relative path, as a browser does', () => {
      // Not a bug, and worth pinning: `<a href="not a url at all">` is a link
      // to `/not%20a%20url%20at%20all` in every browser, and a crawler that
      // silently dropped it would under-report a site's links. It is refused
      // later — by the frontier's caps and by the 404 the server returns —
      // rather than by pretending the markup does not exist.
      expect(normaliseUrl('not a url at all', { base: 'https://example.test/' })).toBe(
        'https://example.test/not%20a%20url%20at%20all',
      );
      // With no base there is nothing to resolve against, so it is not a URL.
      expect(normaliseUrl('not a url at all')).toBeNull();
    });

    it('returns null rather than a repaired guess', () => {
      // A half-parsed URL that "looks close" enqueues the WRONG page, which is
      // worse than enqueueing none.
      expect(normaliseUrl('ht!tp://example.test')).toBeNull();
    });
  });

  describe('idempotence', () => {
    it.each([
      'https://EXAMPLE.test:443/a/./b/../c?utm_source=x&b=2&a=1#frag',
      'http://example.test./',
      'https://example.test/a%7Eb%2Fc',
    ])('normalising twice changes nothing: %s', (input) => {
      const once = normaliseUrl(input);
      expect(once).not.toBeNull();
      expect(normaliseUrl(once!)).toBe(once);
    });
  });
});

describe('urlDepth', () => {
  it.each([
    ['https://example.test/', 0],
    ['https://example.test/about', 1],
    ['https://example.test/blog/2026', 2],
    ['https://example.test/blog/2026/a-post', 3],
    ['https://example.test/a/b/c/d/e', 5],
  ])('%s → %i', (url, depth) => {
    expect(urlDepth(url)).toBe(depth);
  });

  it('ignores a trailing slash', () => {
    expect(urlDepth('https://example.test/blog/')).toBe(1);
  });
});

describe('crawl scope', () => {
  const scope = crawlScope('https://www.example.test');

  it('admits the verified origin', () => {
    expect(classifyScope('https://www.example.test/about', scope)).toBe('in_scope');
    expect(isFetchable('https://www.example.test/', scope)).toBe(true);
  });

  it('⚠️ treats another subdomain as out of scope, not as the same site', () => {
    // On wordpress.com, myshopify.com or github.io, "the same registrable
    // domain" is every other tenant of the platform. Whatever it is CALLED, it
    // is not fetched — which is the property that matters.
    expect(isFetchable('https://blog.example.test/x', scope)).toBe(false);
    expect(isFetchable('https://example.test/', scope)).toBe(false);
  });

  it('names a provable parent/child relationship, and only that', () => {
    // From the APEX, `www` and `blog` are children and provably related.
    const apex = crawlScope('https://example.test');
    expect(classifyScope('https://www.example.test/', apex)).toBe('other_subdomain');
    expect(classifyScope('https://blog.example.test/', apex)).toBe('other_subdomain');

    // From `www`, its SIBLING `blog` reports `external` — recognising siblings
    // needs the registrable domain, which needs the Public Suffix List, which
    // has no safe wrong answer on a platform host. The code claims only what it
    // can prove; see the note in scope.ts.
    expect(classifyScope('https://blog.example.test/', scope)).toBe('external');

    // And the parent direction, which IS provable.
    expect(classifyScope('https://example.test/', scope)).toBe('other_subdomain');
  });

  it('reports a third party as external', () => {
    expect(classifyScope('https://facebook.test/abcplumbing', scope)).toBe('external');
    expect(classifyScope('https://cdn.jsdelivr.test/x.js', scope)).toBe('external');
  });

  it('names the reason rather than returning a bare false', () => {
    // "412 external links" and "38 links to an unverified subdomain" are
    // separately useful; "450 links we did not follow" is not.
    const apex = crawlScope('https://example.test');
    const verdicts = [
      classifyScope('https://example.test/a', apex),
      classifyScope('https://blog.example.test/a', apex),
      classifyScope('https://other.test/a', apex),
    ];
    expect(verdicts).toEqual(['in_scope', 'other_subdomain', 'external']);
  });

  describe('the scheme upgrade', () => {
    const http = crawlScope('http://example.test');

    it('follows http → https on the SAME host', () => {
      // Without it, the first fetch of an http site leaves scope on hop one,
      // because almost every site redirects to https.
      expect(classifyScope('https://example.test/', http)).toBe('scheme_upgrade');
      expect(isFetchable('https://example.test/', http)).toBe(true);
    });

    it('does not follow it to a different host', () => {
      expect(isFetchable('https://www.example.test/', http)).toBe(false);
    });

    it('does not downgrade https → http', () => {
      expect(isFetchable('http://www.example.test/', scope)).toBe(false);
    });

    it('can be turned off', () => {
      expect(isFetchable('https://example.test/', crawlScope('http://example.test', false))).toBe(
        false,
      );
    });
  });

  describe('redirectGuard', () => {
    const guard = redirectGuard(scope);

    it('permits a redirect inside the site', () => {
      expect(
        guard(new URL('https://www.example.test/a'), new URL('https://www.example.test/b')),
      ).toBe(true);
    });

    it('⚠️ refuses a redirect off the site rather than following and discarding', () => {
      // Following first would make the request the scope exists to prevent.
      expect(guard(new URL('https://www.example.test/a'), new URL('https://other.test/b'))).toBe(
        false,
      );
    });
  });
});
