/**
 * URL normalisation — crawl identity.
 *
 * WHY THIS SUITE IS LONG
 * Every case here is a way one page becomes two rows. A crawler that reports
 * 428 pages for a 214-page site is not slightly wrong; every count downstream
 * is wrong, and there is no way to tell from the output which half is real.
 */

import { describe, expect, it } from 'vitest';
import { MAX_URL_LENGTH } from '@growth-os/net';
import { normaliseUrl, STRIPPED_PARAMETERS, urlDepth } from './normalise';
import { isAllowed, parseRobotsTxt } from '../robots/parse';
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

/**
 * The length ceiling.
 *
 * WHY THIS SUITE EXISTS AT ALL
 * Not to validate input. The regex sweep (dev log 0018) measured `isAllowed`
 * blocking the event loop for over twelve seconds against a hostile robots.txt
 * and a long path, because the matcher is O(rules × pattern × target) and
 * `target` had no bound. This ceiling is where that bound lives.
 *
 * @see docs/decisions/ADR-0038-url-length-ceiling.md
 */
describe('normaliseUrl — the length ceiling', () => {
  const origin = 'https://x.test/';
  const atCap = origin + 'a'.repeat(MAX_URL_LENGTH - origin.length);

  describe('the boundary', () => {
    it('accepts a URL of exactly MAX_URL_LENGTH', () => {
      expect(atCap.length).toBe(MAX_URL_LENGTH);
      expect(normaliseUrl(atCap)).toBe(atCap);
    });

    it('refuses one character over', () => {
      const oneOver = origin + 'a'.repeat(MAX_URL_LENGTH - origin.length + 1);
      expect(oneOver.length).toBe(MAX_URL_LENGTH + 1);
      expect(normaliseUrl(oneOver)).toBeNull();
    });

    it('⚠️ refuses a URL under the cap on input that exceeds it after normalising', () => {
      // `+` becomes `%20` in the query — measured at 2.98× on this shape. A cap
      // applied only to the input would let this through and store 3,018
      // characters in a column bounded at 2,048.
      const input = `${origin}?q=${'+'.repeat(1_000)}`;
      expect(input.length).toBeLessThan(MAX_URL_LENGTH);
      expect(normaliseUrl(input)).toBeNull();
    });

    it('a long input is refused before any normalisation work runs', () => {
      // The point of the input cap: cost is incurred PRODUCING the output, so
      // capping only the output does not bound the work.
      const huge = `${origin}?q=${'+'.repeat(500_000)}`;
      const started = performance.now();
      expect(normaliseUrl(huge)).toBeNull();
      expect(performance.now() - started).toBeLessThan(50);
    });

    it('trims before measuring, so whitespace does not consume the budget', () => {
      expect(normaliseUrl(`   ${atCap}   `)).toBe(atCap);
    });

    it('applies the ceiling to the resolved URL, not the relative href', () => {
      // A six-character href is under any input cap. What gets stored is the
      // resolution, so that is what the ceiling has to measure.
      const base = `${origin}${'d'.repeat(2_100)}/`;
      const resolved = `${origin}${'d'.repeat(2_100)}/page`;
      expect('./page'.length).toBeLessThan(MAX_URL_LENGTH);
      expect(resolved.length).toBeGreaterThan(MAX_URL_LENGTH);
      expect(normaliseUrl('./page', { base })).toBeNull();
    });
  });

  describe('⚠️ the property that matters: the matcher cannot be reached with a long target', () => {
    // The exact corpus from dev log 0018 — surviving rules of the shape that
    // defeats the two-pointer scan: long literal runs either side of one star,
    // so every star retry re-compares the whole literal.
    const rule = `Disallow: /${'a'.repeat(1_000)}*${'a'.repeat(1_000)}b`;
    const robots = parseRobotsTxt(`User-agent: *\n${`${rule}\n`.repeat(300)}`);

    it('parses to the corpus the measurement was taken against', () => {
      expect(robots.truncated).toBe(true);
      // ⚠️ 254, NOT 255, AND THAT IS THE FIX LANDING (ADR-0040). The 255th
      // "rule" was never a rule: the 512,000-byte cap cut the last line
      // mid-pattern and the parser kept the stump. ADR-0038 named it as the
      // truncation defect awaiting its own brief; this is that brief, and a
      // partial line is now discarded instead of being turned into a directive.
      expect(robots.groups[0]?.rules.length).toBe(254);
    });

    it('refuses the 10,000-character path that cost over twelve seconds', () => {
      const hostile = origin + 'a'.repeat(10_000 - origin.length);
      // null means `isAllowed` is never called with it — decide.ts:116 returns
      // before decide.ts:150. This is the strong property: not "it was
      // validated" but "the expensive input cannot arrive".
      expect(normaliseUrl(hostile)).toBeNull();
    });

    it('costs bounded time at the ceiling against the same hostile corpus', () => {
      // Measured on the capped path only, because the uncapped one is the bug.
      const started = performance.now();
      const verdict = isAllowed(robots, atCap);
      const elapsed = performance.now() - started;

      // ⚠️ THE STUMP IS GONE, AND THE VERDICT SURVIVED IT (ADR-0040). Two ADRs
      // ago this comment explained that the refusal came from a fabricated
      // 420-character `Disallow: /aaa…` — the cut rule with its `*` and final
      // `b` removed — rather than from the 254 hostile rules, and that
      // asserting the boolean would break when the truncation defect was fixed.
      // It has now been fixed: the partial line is discarded. The refusal below
      // therefore comes from the hostile rules themselves, via the step budget,
      // which is what this test was always trying to cover.
      //
      // ⚠️ THE REASON CHANGED, AND IT WAS SUPPOSED TO (ADR-0039). It read
      // `longest_match` when the matcher would pay any price to reach an answer.
      // The step budget refuses to, so the deciding rule here is now one whose
      // match was presumed rather than computed. Updated rather than relaxed:
      // this pins the fail-closed outcome, where the old assertion pinned only
      // that some rule had won.
      expect(verdict.reason).toBe('budget_exhausted');
      expect(verdict.allowed).toBe(false);

      // Observed ~76 ms at the cap before the step budget and ~25 ms after, on
      // this machine, against ~16,800 ms at 10,000 characters. The threshold
      // asserts the collapse in order of magnitude, not a machine-specific
      // number.
      expect(elapsed).toBeLessThan(1_000);
    });
  });
});

// ---------------------------------------------------------------------------
// §6 the query identity collision — dev log 0018 finding 4, see ADR-0041
// ---------------------------------------------------------------------------

describe('⚠️ query values keep their bytes — URL identity is singular', () => {
  it('⚠️ five distinct URLs must not share two identities', () => {
    // Dev log 0018, measured on a legacy Latin-1 site. `URLSearchParams`
    // decodes to a JS string, so every byte that is not valid UTF-8 becomes
    // U+FFFD and re-encodes as %EF%BF%BD. Five pages, two rows.
    const five = [
      'https://example.test/search?q=Fran%E7ois',
      'https://example.test/search?q=Fran%E8ois',
      'https://example.test/search?q=Fran%E9ois',
      'https://example.test/search?q=caf%E9',
      'https://example.test/search?q=caf%E8',
    ];

    const identities = new Set(five.map((input) => normaliseUrl(input)));
    expect(identities.size).toBe(five.length);

    // And each one is itself, not a replacement character.
    expect(normaliseUrl(five[0]!)).toBe('https://example.test/search?q=Fran%E7ois');
    expect(normaliseUrl(five[3]!)).toBe('https://example.test/search?q=caf%E9');
  });

  it('⚠️ the same bytes in the path and in the query now agree', () => {
    // The asymmetry was the clearest statement of the defect: one URL, two
    // halves, incompatible rules.
    expect(normaliseUrl('https://example.test/produits/caf%E9')).toBe(
      'https://example.test/produits/caf%E9',
    );
    expect(normaliseUrl('https://example.test/produits?nom=caf%E9')).toBe(
      'https://example.test/produits?nom=caf%E9',
    );
  });

  it('⚠️ PROPERTY: 256 single-byte query values produce 256 identities', () => {
    // The strong form. Before this fix the 128 bytes 0x80–0xFF shared ONE
    // identity, so this asserted 129.
    const inputs = Array.from(
      { length: 256 },
      (_, b) => `https://e.test/s?q=%${b.toString(16).toUpperCase().padStart(2, '0')}`,
    );
    const identities = new Set(inputs.map((input) => normaliseUrl(input)));
    expect(identities.size).toBe(256);
  });

  it('⚠️ PROPERTY: no two distinct URLs share an identity across a non-UTF-8 corpus', () => {
    // Every high byte, in three positions: alone, embedded in a word, and
    // beside a second parameter. 99.2 % of these collided before.
    const corpus: string[] = [];
    for (let b = 0x80; b <= 0xff; b++) {
      const hex = b.toString(16).toUpperCase().padStart(2, '0');
      corpus.push(`https://e.test/s?q=caf%${hex}`);
      corpus.push(`https://e.test/s?q=Fran%${hex}ois`);
      corpus.push(`https://e.test/s?a=%${hex}&b=1`);
    }

    const byIdentity = new Map<string, string[]>();
    for (const input of corpus) {
      const id = normaliseUrl(input);
      expect(id).not.toBeNull();
      byIdentity.set(id!, [...(byIdentity.get(id!) ?? []), input]);
    }

    const collisions = [...byIdentity.entries()].filter(([, xs]) => xs.length > 1);
    expect(collisions, `collisions: ${JSON.stringify(collisions.slice(0, 3))}`).toEqual([]);
    expect(byIdentity.size).toBe(corpus.length);
  });

  it('⚠️ a malformed escape is no longer confused with the escaped percent', () => {
    // `%ZZ` is not an escape. Decoding it to `%` and re-encoding produced
    // `%25ZZ` — the identity of a genuinely different URL.
    expect(normaliseUrl('https://e.test/s?q=%ZZ')).not.toBe(
      normaliseUrl('https://e.test/s?q=%25ZZ'),
    );
    expect(normaliseUrl('https://e.test/s?q=%')).not.toBe(normaliseUrl('https://e.test/s?q=%25'));
  });

  describe('hostile query input (§6)', () => {
    it.each([
      ['a lone surrogate', 'q=%ED%A0%80', 'https://e.test/s?q=%ED%A0%80'],
      ['overlong UTF-8', 'q=%C0%80', 'https://e.test/s?q=%C0%80'],
      ['a truncated escape', 'q=%ZZ', 'https://e.test/s?q=%ZZ'],
      ['a bare percent', 'q=%', 'https://e.test/s?q=%'],
      ['a one-digit escape', 'q=%A', 'https://e.test/s?q=%A'],
      ['mixed valid and invalid bytes', 'q=caf%C3%A9%E9', 'https://e.test/s?q=caf%C3%A9%E9'],
      ['a value that is entirely escapes', 'q=%E7%E8%E9', 'https://e.test/s?q=%E7%E8%E9'],
      ['a NUL byte', 'q=%00', 'https://e.test/s?q=%00'],
      ['hex case is canonicalised', 'q=%e7', 'https://e.test/s?q=%E7'],
    ])('%s survives: %s', (_label, query, expected) => {
      expect(normaliseUrl(`https://e.test/s?${query}`)).toBe(expected);
    });

    it('⚠️ keeps the halves of a surrogate pair split across two parameters apart', () => {
      // Each half is invalid UTF-8 alone, so both used to become U+FFFD and the
      // two parameters became indistinguishable.
      const high = normaliseUrl('https://e.test/s?a=%ED%A0%BD');
      const low = normaliseUrl('https://e.test/s?a=%ED%B8%80');
      expect(high).not.toBe(low);
      expect(normaliseUrl('https://e.test/s?a=%ED%A0%BD&b=%ED%B8%80')).toBe(
        'https://e.test/s?a=%ED%A0%BD&b=%ED%B8%80',
      );
    });

    it('⚠️ decoding can never manufacture a query delimiter', () => {
      // The property that makes byte-preserving normalisation safe: only the
      // RFC 3986 unreserved set is decoded, and it contains no delimiter. If
      // `%26` decoded, one parameter would silently become two.
      expect(normaliseUrl('https://e.test/s?q=a%26b%3Dc')).toBe('https://e.test/s?q=a%26b%3Dc');
      expect(normaliseUrl('https://e.test/s?q=a%23b')).toBe('https://e.test/s?q=a%23b');
      expect(normaliseUrl('https://e.test/s?q=a%3Fb')).toBe('https://e.test/s?q=a%3Fb');
    });
  });

  describe('the query still does its job', () => {
    it('strips tracking beside a non-UTF-8 value', () => {
      expect(normaliseUrl('https://e.test/s?utm_source=g&q=caf%E9&gclid=X')).toBe(
        'https://e.test/s?q=caf%E9',
      );
    });

    it('sorts by name with non-UTF-8 values present', () => {
      expect(normaliseUrl('https://e.test/s?b=caf%E9&a=caf%E8')).toBe(
        'https://e.test/s?a=caf%E8&b=caf%E9',
      );
    });

    it('preserves repeat order with non-UTF-8 values', () => {
      expect(normaliseUrl('https://e.test/s?tag=%E9&tag=%E8')).toBe(
        'https://e.test/s?tag=%E9&tag=%E8',
      );
      expect(normaliseUrl('https://e.test/s?tag=%E8&tag=%E9')).toBe(
        'https://e.test/s?tag=%E8&tag=%E9',
      );
    });

    it('still folds + and %20 to one spelling', () => {
      expect(normaliseUrl('https://e.test/s?q=caf%E9+x')).toBe(
        normaliseUrl('https://e.test/s?q=caf%E9%20x'),
      );
    });

    it('⚠️ the strip list stays case-INSENSITIVE, and PHPSESSID is why', () => {
      // Measured: PHP's default cookieless session parameter is literally
      // `PHPSESSID`, uppercase. Matching case-sensitively would stop stripping
      // it, and an unstripped session id is a new identity per visitor —
      // unbounded, and strictly worse than the case it would fix. See ADR-0041.
      expect(normaliseUrl('https://e.test/p?PHPSESSID=abc')).toBe('https://e.test/p');
      expect(normaliseUrl('https://e.test/p?JSESSIONID=abc')).toBe('https://e.test/p');
      expect(normaliseUrl('https://e.test/p?CFID=1&CFTOKEN=2')).toBe('https://e.test/p');
      expect(normaliseUrl('https://e.test/p?UTM_SOURCE=g')).toBe('https://e.test/p');
    });
  });

  it('⚠️ PROPERTY: the identity is a fixed point the fetcher will agree with', () => {
    // The stored string is re-parsed later by admitUrl and by the fetcher. If
    // `new URL()` rewrote it, the row we stored would not be the URL we ask
    // for — a different way of storing an identity nobody linked.
    const inputs = [
      'https://e.test/s?q=%',
      'https://e.test/s?q=%A',
      'https://e.test/s?q=%ZZ',
      'https://e.test/s?q=~',
      'https://e.test/s?q=%7E',
      'https://e.test/s?a=1;b=2',
      'https://e.test/s?q=caf%E9',
      'https://e.test/s?q=%FF',
      'https://e.test/s?q=%00',
      'https://e.test/s?q=%C0%80',
      'https://e.test/s?q=a%20b',
      'https://e.test/s?q=%2B',
      'https://e.test/s?q=%5B%5D',
      'https://e.test/s?q=%22',
    ];

    for (const input of inputs) {
      const id = normaliseUrl(input);
      expect(id, input).not.toBeNull();
      expect(normaliseUrl(id!), `not idempotent: ${input}`).toBe(id);
      expect(new URL(id!).href, `href rewrites the identity: ${input}`).toBe(id);
    }
  });

  it('leaves URLs with no query exactly as they were', () => {
    // The regression guard: this change must be invisible to everything that
    // is not a query.
    expect(normaliseUrl('https://e.test/produits/caf%E9')).toBe('https://e.test/produits/caf%E9');
    expect(normaliseUrl('https://e.test/a/../b')).toBe('https://e.test/b');
    expect(normaliseUrl('HTTPS://E.TEST:443/x/')).toBe('https://e.test/x/');
    expect(normaliseUrl('https://e.test/a%7Eb')).toBe('https://e.test/a~b');
    expect(normaliseUrl('https://e.test./x')).toBe('https://e.test/x');
  });
});
