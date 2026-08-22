/**
 * Link extraction, including what a hostile or merely careless document does to it.
 *
 * AGENTS.md §6 requires hostile-input tests for anything parsing the outside
 * world. HTML is the most hostile input this system takes: it is
 * attacker-influenced on any site that accepts comments, and malformed on most
 * sites that do not.
 *
 * The property that matters throughout is that extraction TERMINATES and
 * returns facts — never that it rejects a document. A crawler that refuses
 * malformed markup would refuse most of the web.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ANCHOR_TEXT_LENGTH,
  MAX_LINKS_PER_PAGE,
  decodeEntities,
  extractLinks,
} from './extract';
import { crawlScope } from '../urls/scope';

const BASE = 'https://abcplumbing.test/services/boilers';
const SCOPE = crawlScope('https://abcplumbing.test');

const hrefs = (html: string, base = BASE): string[] =>
  extractLinks(html, base, SCOPE).map((link) => link.targetUrl);

describe('extractLinks — the ordinary cases', () => {
  it('extracts an absolute link', () => {
    expect(hrefs('<a href="https://example.test/page">x</a>')).toEqual([
      'https://example.test/page',
    ]);
  });

  it('resolves a root-relative href against the base', () => {
    expect(hrefs('<a href="/about">About</a>')).toEqual(['https://abcplumbing.test/about']);
  });

  it('resolves a document-relative href against the base PATH', () => {
    expect(hrefs('<a href="radiators">Radiators</a>')).toEqual([
      'https://abcplumbing.test/services/radiators',
    ]);
  });

  it('captures anchor text, collapsed', () => {
    const [link] = extractLinks('<a href="/x">  Emergency\n   callout  </a>', BASE, SCOPE);
    expect(link?.anchorText).toBe('Emergency callout');
  });

  it('strips nested markup from anchor text', () => {
    const [link] = extractLinks('<a href="/x"><span>Book</span> <b>now</b></a>', BASE, SCOPE);
    expect(link?.anchorText).toBe('Book now');
  });

  it('an anchor with no text records null, not an empty string', () => {
    const [link] = extractLinks('<a href="/x"><img src="/y.png"></a>', BASE, SCOPE);
    expect(link?.anchorText).toBeNull();
  });

  it('handles single-quoted and unquoted hrefs', () => {
    expect(hrefs("<a href='/single'>a</a><a href=/unquoted>b</a>")).toEqual([
      'https://abcplumbing.test/single',
      'https://abcplumbing.test/unquoted',
    ]);
  });

  it('records multiple links to the same target — they are separate facts', () => {
    // Two links to one page is what an internal-link count counts.
    const links = extractLinks('<a href="/x">One</a><a href="/x">Two</a>', BASE, SCOPE);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.anchorText)).toEqual(['One', 'Two']);
  });
});

describe('⚠️ hrefs that are not crawlable pages', () => {
  it.each([
    ['mailto:', '<a href="mailto:sam@abcplumbing.test">Email</a>'],
    ['tel:', '<a href="tel:+441134960000">Call</a>'],
    ['javascript:', '<a href="javascript:void(0)">Menu</a>'],
    ['fragment only', '<a href="#main">Skip to content</a>'],
    ['empty href', '<a href="">Nothing</a>'],
  ])('drops %s', (_label, html) => {
    // `normaliseUrl` owns this judgement — URL identity is singular (§5), so
    // this module never decides for itself what is crawlable.
    expect(hrefs(html)).toEqual([]);
  });

  it('an anchor with no href attribute at all is not a link', () => {
    expect(hrefs('<a name="section">Anchor target</a>')).toEqual([]);
  });
});

describe('⚠️ regions whose contents are not links', () => {
  it('ignores links inside comments', () => {
    expect(hrefs('<!-- <a href="/commented">x</a> --><a href="/real">y</a>')).toEqual([
      'https://abcplumbing.test/real',
    ]);
  });

  it.each(['script', 'style', 'template', 'noscript', 'svg'])(
    'ignores links inside <%s>',
    (element) => {
      const html = `<${element}><a href="/hidden">x</a></${element}><a href="/real">y</a>`;
      expect(hrefs(html)).toEqual(['https://abcplumbing.test/real']);
    },
  );

  it('an unterminated comment swallows the rest of the document rather than hanging', () => {
    expect(hrefs('<a href="/before">x</a><!-- <a href="/after">y</a>')).toEqual([
      'https://abcplumbing.test/before',
    ]);
  });

  it('an unclosed <script> hides the remainder, which is what a browser does', () => {
    expect(hrefs('<a href="/before">x</a><script><a href="/after">y</a>')).toEqual([
      'https://abcplumbing.test/before',
    ]);
  });
});

describe('rel and nofollow', () => {
  it('marks rel="nofollow"', () => {
    const [link] = extractLinks('<a href="/x" rel="nofollow">x</a>', BASE, SCOPE);
    expect(link?.isNofollow).toBe(true);
  });

  it.each(['ugc', 'sponsored'])('folds rel="%s" into nofollow', (token) => {
    // The schema records one boolean; all three say "do not pass weight".
    const [link] = extractLinks(`<a href="/x" rel="${token}">x</a>`, BASE, SCOPE);
    expect(link?.isNofollow).toBe(true);
  });

  it('finds nofollow among several rel tokens, case-insensitively', () => {
    const [link] = extractLinks(
      '<a href="/x" rel="NoOpener NOFOLLOW noreferrer">x</a>',
      BASE,
      SCOPE,
    );
    expect(link?.isNofollow).toBe(true);
  });

  it('rel="noopener" alone is not nofollow', () => {
    const [link] = extractLinks('<a href="/x" rel="noopener">x</a>', BASE, SCOPE);
    expect(link?.isNofollow).toBe(false);
  });

  it('a link with no rel is followed', () => {
    const [link] = extractLinks('<a href="/x">x</a>', BASE, SCOPE);
    expect(link?.isNofollow).toBe(false);
  });
});

describe('⚠️ <base href> changes what every relative link means', () => {
  it('relative links resolve against <base>, not the fetch URL', () => {
    const html = '<head><base href="https://cdn.abcplumbing.test/v2/"></head><a href="x">x</a>';
    expect(hrefs(html)).toEqual(['https://cdn.abcplumbing.test/v2/x']);
  });

  it('the FIRST base wins — a second is ignored', () => {
    const html =
      '<base href="https://first.test/"><base href="https://second.test/"><a href="x">x</a>';
    expect(hrefs(html)).toEqual(['https://first.test/x']);
  });

  it('a base that is itself relative resolves against the fetch URL', () => {
    expect(hrefs('<base href="/v2/"><a href="x">x</a>')).toEqual(['https://abcplumbing.test/v2/x']);
  });

  it('an unparseable base is ignored rather than breaking every link', () => {
    expect(hrefs('<base href="javascript:void(0)"><a href="/x">x</a>')).toEqual([
      'https://abcplumbing.test/x',
    ]);
  });
});

describe('⚠️ link scope is delegated to urls/scope.ts, never re-derived', () => {
  const scopeOf = (target: string, site = 'https://abcplumbing.test') =>
    extractLinks(`<a href="${target}">x</a>`, BASE, crawlScope(site))[0]?.scope;

  it('the same host is internal', () => {
    expect(scopeOf('https://abcplumbing.test/a')).toBe('internal');
  });

  it('a subdomain of the site is other_subdomain', () => {
    expect(scopeOf('https://blog.abcplumbing.test/a')).toBe('other_subdomain');
  });

  it('a different domain is external', () => {
    expect(scopeOf('https://competitor.test/a')).toBe('external');
  });

  it("⚠️ a scheme upgrade is internal — a site's own pre-TLS links are not outbound", () => {
    expect(scopeOf('https://abcplumbing.test/a', 'http://abcplumbing.test')).toBe('internal');
  });

  it('⚠️ sibling subdomains are external — the SAFE direction without a PSL', () => {
    // urls/scope.ts owns this: blog.example.com is NOT the same owner on
    // wordpress.com, myshopify.com or github.io, which are exactly the hosts
    // small businesses use.
    expect(scopeOf('https://shop.abcplumbing.test/a', 'https://blog.abcplumbing.test')).toBe(
      'external',
    );
  });

  it('⚠️ a two-label heuristic would be WRONG, which is why nothing here has one', () => {
    // abcplumbing.co.uk and competitor.co.uk share their last two labels and
    // are different companies. This product's customers are largely UK
    // businesses.
    expect(scopeOf('https://competitor.co.uk/a', 'https://abcplumbing.co.uk')).toBe('external');
  });

  it('scope follows the SITE, not the page the link sits on', () => {
    // The same link, classified against two different sites.
    expect(scopeOf('https://abcplumbing.test/a', 'https://abcplumbing.test')).toBe('internal');
    expect(scopeOf('https://abcplumbing.test/a', 'https://competitor.test')).toBe('external');
  });
});

describe('decodeEntities', () => {
  it('⚠️ decodes &amp; in a query string — the common case, not an edge case', () => {
    // Valid HTML REQUIRES `&amp;`, so this is what a correct document contains.
    expect(hrefs('<a href="/s?a=1&amp;b=2">x</a>')).toEqual(['https://abcplumbing.test/s?a=1&b=2']);
  });

  it('decodes numeric and hex entities', () => {
    expect(decodeEntities('caf&#233; &#xe9;')).toBe('café é');
  });

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });

  it('an out-of-range code point is left as written', () => {
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });

  it('a bare ampersand is untouched', () => {
    expect(decodeEntities('Tom & Jerry')).toBe('Tom & Jerry');
  });
});

describe('⚠️ hostile and malformed input', () => {
  it('an unclosed anchor takes the rest of the document, as a browser would', () => {
    const [link] = extractLinks('<a href="/x">text with no close', BASE, SCOPE);
    expect(link?.targetUrl).toBe('https://abcplumbing.test/x');
    expect(link?.anchorText).toBe('text with no close');
  });

  it('an unterminated attribute quote does not hang the scanner', () => {
    expect(() => extractLinks('<a href="/x rel=nofollow>text', BASE, SCOPE)).not.toThrow();
  });

  it('absurd nesting terminates', () => {
    const html = `${'<div>'.repeat(50_000)}<a href="/deep">x</a>${'</div>'.repeat(50_000)}`;
    expect(hrefs(html)).toEqual(['https://abcplumbing.test/deep']);
  });

  it('⚠️ a pathological attribute string does not backtrack — it is a forward scan', () => {
    // The shape that kills a naive regex. Bounded here because the scanner
    // never backtracks; if this ever hangs, the implementation changed.
    const html = `<a ${'href='.repeat(20_000)}"/x">text</a>`;
    const start = Date.now();
    expect(() => extractLinks(html, BASE, SCOPE)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('caps the number of links from one document', () => {
    const html = '<a href="/x">x</a>'.repeat(MAX_LINKS_PER_PAGE + 500);
    expect(extractLinks(html, BASE, SCOPE)).toHaveLength(MAX_LINKS_PER_PAGE);
  });

  it('caps anchor text length', () => {
    const [link] = extractLinks(
      `<a href="/x">${'y'.repeat(MAX_ANCHOR_TEXT_LENGTH * 4)}</a>`,
      BASE,
      SCOPE,
    );
    expect(link?.anchorText?.length).toBe(MAX_ANCHOR_TEXT_LENGTH);
  });

  it.each([
    ['empty document', ''],
    ['no markup at all', 'just some text'],
    ['only a stray bracket', '<'],
    ['only a comment', '<!-- nothing -->'],
    ['a bare closing tag', '</a>'],
    ['angle brackets in text', 'a < b and c > d'],
  ])('%s yields no links and does not throw', (_label, html) => {
    expect(extractLinks(html, BASE, SCOPE)).toEqual([]);
  });

  it('uppercase and mixed-case tags are recognised', () => {
    expect(hrefs('<A HREF="/x">X</A>')).toEqual(['https://abcplumbing.test/x']);
  });

  it('a duplicate href attribute takes the first, as browsers do', () => {
    expect(hrefs('<a href="/first" href="/second">x</a>')).toEqual([
      'https://abcplumbing.test/first',
    ]);
  });

  it('a self-closing anchor is handled', () => {
    expect(hrefs('<a href="/x" />')).toEqual(['https://abcplumbing.test/x']);
  });

  it('a very long document completes in reasonable time', () => {
    const html = `${'<p>filler text </p>'.repeat(50_000)}<a href="/x">x</a>`;
    const start = Date.now();
    expect(hrefs(html)).toEqual(['https://abcplumbing.test/x']);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
