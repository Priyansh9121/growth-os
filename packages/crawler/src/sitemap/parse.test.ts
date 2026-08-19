/**
 * Sitemap parsing — the most dangerous format the crawler touches.
 *
 * ⚠️ MOSTLY HOSTILE INPUT, AND THE XXE BLOCK IS THE POINT. An XML parser that
 * resolves external entities reads local files and dials internal addresses on
 * behalf of whoever wrote the document. That is not a parsing bug, it is a file
 * disclosure and an SSRF primitive delivered as a sitemap.
 *
 * Every URL here is asserted in its NORMALISED form, because §5 says there is
 * one `normaliseUrl` and a sitemap must not be a second opinion about identity.
 *
 * @see docs/decisions/ADR-0050-sitemap-parsing.md
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SITEMAP_LIMITS, parseSitemap } from './parse';

const BASE = 'https://abcplumbing.test/sitemap.xml';

const urlset = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${inner}</urlset>`;

const loc = (href: string): string => `<url><loc>${href}</loc></url>`;

describe('parseSitemap — a plain urlset', () => {
  it('reads the URLs a site lists', () => {
    const doc = parseSitemap(
      urlset(loc('https://abcplumbing.test/') + loc('https://abcplumbing.test/contact')),
      BASE,
    );

    expect(doc.kind).toBe('urlset');
    if (doc.kind !== 'urlset') return;
    expect(doc.entries.map((e) => e.url)).toEqual([
      'https://abcplumbing.test/',
      'https://abcplumbing.test/contact',
    ]);
  });

  it('records lastmod, changefreq and priority as the site wrote them', () => {
    // ⚠️ FACTS, NOT FINDINGS (§5). `priority` is the site's own claim about
    // what matters. Storing it is a fact; ordering a crawl by it would be a
    // judgement, and that belongs to the frontier, not here.
    const doc = parseSitemap(
      urlset(
        `<url><loc>https://abcplumbing.test/a</loc><lastmod>2026-08-19</lastmod>` +
          `<changefreq>daily</changefreq><priority>0.8</priority></url>`,
      ),
      BASE,
    );

    expect(doc.kind).toBe('urlset');
    if (doc.kind !== 'urlset') return;
    expect(doc.entries[0]).toEqual({
      url: 'https://abcplumbing.test/a',
      lastmod: '2026-08-19',
      changefreq: 'daily',
      priority: '0.8',
    });
  });

  it('leaves the optional fields null when absent', () => {
    const doc = parseSitemap(urlset(loc('https://abcplumbing.test/a')), BASE);
    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries[0]).toEqual({
      url: 'https://abcplumbing.test/a',
      lastmod: null,
      changefreq: null,
      priority: null,
    });
  });

  it('⚠️ routes every URL through the one normaliseUrl (§5)', () => {
    // Tracking parameters stripped, query sorted, default port removed — none
    // of which this file implements. If a sitemap could disagree with the
    // frontier about identity, the same page would be crawled twice.
    const doc = parseSitemap(
      urlset(loc('https://abcplumbing.test:443/a?utm_source=x&b=2&a=1')),
      BASE,
    );
    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries[0]?.url).toBe('https://abcplumbing.test/a?a=1&b=2');
  });

  it('resolves a relative loc against the sitemap it came from', () => {
    const doc = parseSitemap(urlset(loc('/contact')), BASE);
    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries[0]?.url).toBe('https://abcplumbing.test/contact');
  });

  it('counts URLs it could not turn into an identity rather than dropping them silently', () => {
    const doc = parseSitemap(
      urlset(loc('https://abcplumbing.test/a') + loc('javascript:alert(1)') + loc('   ')),
      BASE,
    );
    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries).toHaveLength(1);
    expect(doc.skipped).toBe(2);
  });

  it('decodes the predefined XML entities a real sitemap needs', () => {
    // `&amp;` is how every sitemap on earth writes a query separator.
    const doc = parseSitemap(urlset(loc('https://abcplumbing.test/a?b=1&amp;c=2')), BASE);
    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries[0]?.url).toBe('https://abcplumbing.test/a?b=1&c=2');
  });

  it('accepts a namespace prefix on the elements', () => {
    const doc = parseSitemap(
      `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        `<sm:url><sm:loc>https://abcplumbing.test/a</sm:loc></sm:url></sm:urlset>`,
      BASE,
    );
    expect(doc.kind).toBe('urlset');
    if (doc.kind !== 'urlset') return;
    expect(doc.entries[0]?.url).toBe('https://abcplumbing.test/a');
  });
});

describe('parseSitemap — a sitemapindex', () => {
  it('reads the child sitemaps', () => {
    const doc = parseSitemap(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://abcplumbing.test/sitemap-1.xml</loc><lastmod>2026-08-01</lastmod></sitemap>
        <sitemap><loc>https://abcplumbing.test/sitemap-2.xml</loc></sitemap>
      </sitemapindex>`,
      BASE,
    );

    expect(doc.kind).toBe('sitemapindex');
    if (doc.kind !== 'sitemapindex') return;
    expect(doc.sitemaps).toEqual([
      { url: 'https://abcplumbing.test/sitemap-1.xml', lastmod: '2026-08-01' },
      { url: 'https://abcplumbing.test/sitemap-2.xml', lastmod: null },
    ]);
  });

  it('⚠️ believes the root element, not the child elements', () => {
    // A urlset containing <sitemap> children, and an index containing <url>
    // children. The root decides what the document IS; anything that does not
    // belong under it is not collected. Otherwise a document could be read as
    // both, and "is this a list of pages or a list of sitemaps" would have two
    // answers.
    const asUrlset = parseSitemap(
      urlset(`<sitemap><loc>https://abcplumbing.test/child.xml</loc></sitemap>`),
      BASE,
    );
    expect(asUrlset.kind).toBe('urlset');
    if (asUrlset.kind === 'urlset') expect(asUrlset.entries).toHaveLength(0);

    const asIndex = parseSitemap(
      `<sitemapindex><url><loc>https://abcplumbing.test/a</loc></url></sitemapindex>`,
      BASE,
    );
    expect(asIndex.kind).toBe('sitemapindex');
    if (asIndex.kind === 'sitemapindex') expect(asIndex.sitemaps).toHaveLength(0);
  });
});

describe('⚠️ parseSitemap — XXE and entity expansion', () => {
  /**
   * ⚠️ THE PREMISE OF THESE ASSERTIONS IS MEASURED, NOT ASSUMED.
   *
   * `/etc/passwd` is readable on this machine and contains `root:` — verified
   * below before anything is asserted about its absence. Without that check,
   * "the output does not contain root:" would pass just as happily against a
   * parser that resolved the entity and found nothing there.
   */
  const passwd = readFileSync('/etc/passwd', 'utf8');

  it('the fixture would leak if resolution succeeded — control', () => {
    expect(passwd.length).toBeGreaterThan(0);
    expect(passwd).toContain('root:');
  });

  it('⚠️ never resolves an external entity pointing at a local file', () => {
    const doc = parseSitemap(
      `<?xml version="1.0"?>
<!DOCTYPE urlset [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<urlset><url><loc>&xxe;</loc></url></urlset>`,
      BASE,
    );

    const serialised = JSON.stringify(doc);
    expect(serialised).not.toContain('root:');
    expect(serialised).not.toContain('/bin/');
    expect(serialised).not.toContain('System Administrator');
  });

  it('leaves the entity reference as inert text — what DOES happen', () => {
    // Pinned deliberately. The reference survives as the literal `&xxe;`, which
    // then resolves as a relative URL against the sitemap. That is harmless
    // noise admission will refuse, and it is asserted so that a future change
    // which started resolving entities would have to change this test too —
    // the absence assertions above would still pass if the file were empty.
    const doc = parseSitemap(
      `<!DOCTYPE urlset [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<urlset><url><loc>&xxe;</loc></url></urlset>`,
      BASE,
    );

    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries.map((e) => e.url)).toEqual(['https://abcplumbing.test/&xxe;']);
  });

  it('⚠️ never resolves an external entity pointing at an internal address', () => {
    // The SSRF shape: a sitemap that makes the PARSER dial link-local metadata.
    const doc = parseSitemap(
      `<!DOCTYPE r [ <!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data/"> ]>
<urlset><url><loc>&x;</loc></url></urlset>`,
      BASE,
    );

    // If the entity resolved, the metadata response would be the `<loc>` text.
    // It is not: the address never appears in the output at all.
    expect(JSON.stringify(doc)).not.toContain('169.254.169.254');
    expect(JSON.stringify(doc)).not.toContain('meta-data');
  });

  it('⚠️ does not expand nested internal entities — billion laughs', () => {
    const lol = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
 <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
 <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
 <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
 <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
 <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
]>
<urlset><url><loc>&lol9;</loc></url></urlset>`;

    const started = process.hrtime.bigint();
    const doc = parseSitemap(lol, BASE);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // The strong property: the OUTPUT is smaller than the input. A parser that
    // expanded these would produce 10^9 characters from 809 bytes; one that
    // does not cannot produce more than it was given.
    expect(JSON.stringify(doc).length).toBeLessThan(lol.length);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('the DOCTYPE internal subset does not leak into a URL', () => {
    // htmlparser2 reports `<!DOCTYPE …[` as a processing instruction and the
    // trailing `]>` becomes stray text. It sits outside any <loc>, so it is
    // never read — asserted rather than assumed, because "text we ignore" is
    // only safe while the collector is scoped to <loc>.
    const doc = parseSitemap(
      `<!DOCTYPE urlset [ <!ENTITY e "x"> ]>
<urlset><url><loc>https://abcplumbing.test/a</loc></url></urlset>`,
      BASE,
    );
    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries.map((e) => e.url)).toEqual(['https://abcplumbing.test/a']);
  });
});

describe('⚠️ parseSitemap — the rest of the hostile corpus', () => {
  it('caps the number of entries at the sitemaps.org ceiling and says it truncated', () => {
    // ⚠️ `maxBytes` is raised for this case ON PURPOSE. 60,000 entries is about
    // 3.3 MB, so at the default 2 MB cap the BYTE limit bites first and this
    // would silently be a test of the wrong ceiling — it measured 39,776
    // entries before the limits were separated.
    const many = urlset(
      Array.from({ length: 60_000 }, (_, i) => loc(`https://abcplumbing.test/p${i}`)).join(''),
    );
    const doc = parseSitemap(many, BASE, { ...DEFAULT_SITEMAP_LIMITS, maxBytes: 16 * 1024 * 1024 });

    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries).toHaveLength(DEFAULT_SITEMAP_LIMITS.maxEntries);
    expect(doc.truncated).toBe(true);
  });

  it('the byte cap bites before the entry cap on an oversized document', () => {
    const many = urlset(
      Array.from({ length: 60_000 }, (_, i) => loc(`https://abcplumbing.test/p${i}`)).join(''),
    );
    const doc = parseSitemap(many, BASE);

    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries.length).toBeLessThan(DEFAULT_SITEMAP_LIMITS.maxEntries);
  });

  it('⚠️ truncation drops entries and can never invent one', () => {
    // The asymmetry that makes truncation safe here and made it a DEFECT in
    // robots.txt (dev log 0018): a half-read Disallow became an Allow, but a
    // half-read <loc> is never recorded at all, because an entry is only
    // emitted on its CLOSING tag. Losing pages means crawling less; there is no
    // cut that grants anything.
    // ⚠️ NO CLOSING `</urlset>` — that is what makes it truncated. The first
    // version of this test used the `urlset()` helper, which appends one, so
    // the document was well-formed-enough for the parser to emit REAL closes
    // and the assertion passed against a bug. A byte cut leaves no closing tag.
    const cut = `<urlset>${loc('https://abcplumbing.test/a')}<url><loc>https://abcplumbing.tes`;
    const doc = parseSitemap(cut, BASE);

    if (doc.kind !== 'urlset') throw new Error('expected urlset');
    expect(doc.entries.map((e) => e.url)).toEqual(['https://abcplumbing.test/a']);
  });

  it('stops at an absurd nesting depth instead of following it down', () => {
    const deep = `<urlset>${'<a>'.repeat(5_000)}<url><loc>https://abcplumbing.test/a</loc></url>${'</a>'.repeat(5_000)}</urlset>`;
    const started = process.hrtime.bigint();
    const doc = parseSitemap(deep, BASE);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(doc.kind).toBe('urlset');
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it.each([
    ['not xml at all', 'hello world'],
    ['an empty document', ''],
    ['only whitespace', '   \n  '],
    ['an unclosed root', '<urlset><url><loc>https://a.test/</loc></url>'],
    ['a different XML document', '<rss><channel><title>x</title></channel></rss>'],
    ['an HTML page', '<html><body><p>404</p></body></html>'],
  ])('handles %s without throwing', (_label, input) => {
    expect(() => parseSitemap(input, BASE)).not.toThrow();
  });

  it('reports a document whose root is neither form as unknown', () => {
    const doc = parseSitemap('<rss><channel><title>x</title></channel></rss>', BASE);
    expect(doc.kind).toBe('unknown');
  });

  it('reads a document with a byte-order mark', () => {
    const doc = parseSitemap('﻿' + urlset(loc('https://abcplumbing.test/a')), BASE);
    expect(doc.kind).toBe('urlset');
    if (doc.kind === 'urlset') expect(doc.entries[0]?.url).toBe('https://abcplumbing.test/a');
  });

  it('ignores a lying encoding declaration', () => {
    // The bytes are already a JS string by the time they arrive; the decoder
    // upstream decided the encoding. A declaration claiming otherwise must not
    // change what is read, or a site could relabel its way past the parser.
    const doc = parseSitemap(
      `<?xml version="1.0" encoding="UTF-16"?><urlset>${loc('https://abcplumbing.test/a')}</urlset>`,
      BASE,
    );
    expect(doc.kind).toBe('urlset');
    if (doc.kind === 'urlset') expect(doc.entries[0]?.url).toBe('https://abcplumbing.test/a');
  });

  it('survives a replacement character where invalid bytes were decoded', () => {
    const doc = parseSitemap(urlset(loc('https://abcplumbing.test/caf�')), BASE);
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('caps the bytes it will parse at all', () => {
    const huge = urlset(loc('https://abcplumbing.test/a') + ' '.repeat(3 * 1024 * 1024));
    const started = process.hrtime.bigint();
    const doc = parseSitemap(huge, BASE);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(doc.kind).toBe('urlset');
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
