/**
 * Sitemap XML parsing.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn a sitemap document into the list of URLs a site claims exists. That is
 * all: a sitemap entry is a **fact** — "the site listed this page" — and this
 * layer never decides which of them matter (§5, facts vs findings). `priority`
 * and `changefreq` are recorded exactly as written, uninterpreted, because they
 * are the site's own claims and acting on them is the frontier's decision.
 *
 * ⚠️ EVERY URL GOES THROUGH `normaliseUrl` AND NOTHING ELSE (§5). A sitemap
 * must not be able to disagree with the frontier, the link graph or a canonical
 * tag about what "the same page" means.
 *
 * ⚠️ THIS IS NOT AN ADMISSION CHECK. A `<loc>` is a URL a stranger wrote. It
 * has not passed the SSRF pipeline, robots rules, or crawl scope, and this file
 * deliberately does not check any of them — that happens at admission, exactly
 * as it does for a URL discovered in a link. Duplicating it here would be the
 * second path §5 forbids.
 *
 * @see docs/decisions/ADR-0050-sitemap-parsing.md
 */

import { Parser } from 'htmlparser2';
import { normaliseUrl } from '../urls/normalise';

/**
 * A page the site listed.
 *
 * The three optional fields are strings, not parsed dates or numbers, and that
 * is deliberate: parsing them would mean deciding what an invalid one means,
 * which is a judgement this layer does not make. They are stored as written.
 */
export interface SitemapEntry {
  /** The crawl identity, from `normaliseUrl`. */
  readonly url: string;
  readonly lastmod: string | null;
  readonly changefreq: string | null;
  readonly priority: string | null;
}

/** A child sitemap listed by an index. */
export interface SitemapRef {
  readonly url: string;
  readonly lastmod: string | null;
}

/** Why a document produced nothing. */
export type SitemapRefusal = 'empty' | 'not_a_sitemap';

export type SitemapDocument =
  | {
      readonly kind: 'urlset';
      readonly entries: readonly SitemapEntry[];
      /** `<loc>` values that produced no crawl identity. A fact, not an error. */
      readonly skipped: number;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'sitemapindex';
      readonly sitemaps: readonly SitemapRef[];
      readonly skipped: number;
      readonly truncated: boolean;
    }
  | { readonly kind: 'unknown'; readonly refusal: SitemapRefusal };

export interface SitemapLimits {
  /**
   * 50,000 — the ceiling sitemaps.org states for one file.
   *
   * Over it the extra entries are dropped and `truncated` is set, rather than
   * the document being refused. A sitemap slightly over the limit is a large
   * site, not an attack, and refusing it would lose every URL to punish the
   * last one.
   */
  readonly maxEntries: number;
  /** Bytes parsed. Beyond this the tail is not read. */
  readonly maxBytes: number;
  /** Element nesting followed before deeper elements stop being inspected. */
  readonly maxDepth: number;
  /** Characters kept for one field value, so a single text node cannot grow unbounded. */
  readonly maxFieldLength: number;
}

export const DEFAULT_SITEMAP_LIMITS: SitemapLimits = {
  maxEntries: 50_000,
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 16,
  maxFieldLength: 4_096,
};

/** `<sm:loc>` and `<loc>` are the same element. XML case is not. */
const localName = (name: string): string => {
  const colon = name.indexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
};

const FIELDS = new Set(['loc', 'lastmod', 'changefreq', 'priority']);

interface Record_ {
  loc: string | null;
  lastmod: string | null;
  changefreq: string | null;
  priority: string | null;
}

const emptyRecord = (): Record_ => ({ loc: null, lastmod: null, changefreq: null, priority: null });

/**
 * Parse a sitemap.
 *
 * ⚠️ XXE AND ENTITY EXPANSION — THE PARSER AND THE FLAGS THIS DEPENDS ON.
 *
 * `htmlparser2` v12 with `{ xmlMode: true, decodeEntities: true }`. The safety
 * is structural rather than configured-off, and the distinction matters because
 * a compliant XML parser can usually be *asked* to resolve entities:
 *
 *  - **There is no entity-declaration mechanism.** `<!DOCTYPE …>` is reported
 *    as a processing instruction and never interpreted, so a declared entity
 *    never exists to be expanded. `&xxe;` reaches the document as literal text.
 *  - **`decodeEntities` is a static table, not a resolver.** It decodes the
 *    fixed HTML/XML named and numeric entities via the `entities` package.
 *    Document content cannot extend that table.
 *  - **The library performs no I/O.** There is no `fs` or `http` reference
 *    anywhere in its distribution, so `SYSTEM "file:///…"` has nothing to call
 *    even if a declaration were honoured.
 *  - **No option enables any of this.** The full option surface is `xmlMode`,
 *    `decodeEntities`, `lowerCaseTags`, `lowerCaseAttributeNames`,
 *    `recognizeCDATA`, `recognizeSelfClosing` and `Tokenizer`. Only the last
 *    could change tokenisation, and it is not passed.
 *
 * `decodeEntities: true` is required for correctness, not convenience: `&amp;`
 * is how every real sitemap writes a query separator.
 *
 * ⚠️ AN ENTRY IS EMITTED ON ITS REAL CLOSING TAG, WHICH IS WHAT MAKES
 * TRUNCATION SAFE — AND "REAL" IS LOAD-BEARING. A cut anywhere inside
 * `<url>…</url>` means the element never closes, so the entry is never
 * recorded, so truncation can only ever lose pages: never invent one, never
 * grant anything. That is the opposite of the robots.txt truncation defect in
 * dev log 0018, where a severed `Disallow` became an `Allow`.
 *
 * The qualifier exists because the first version of this was wrong.
 * `parser.end()` synthesises a closing tag for every element still open, so a
 * severed `<loc>https://abcplumbing.test/x` was finalised as the entry
 * `https://abcplumbing.tes`. The `ended` flag below is what makes the claim
 * true; without it this comment describes a property the code did not have.
 */
export function parseSitemap(
  xml: string,
  base: string,
  limits: SitemapLimits = DEFAULT_SITEMAP_LIMITS,
): SitemapDocument {
  const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const bounded = source.length > limits.maxBytes ? source.slice(0, limits.maxBytes) : source;
  if (bounded.trim().length === 0) return { kind: 'unknown', refusal: 'empty' };

  let root: string | null = null;
  let container: string | null = null;

  let depth = 0;
  let containerDepth = -1;
  let field: string | null = null;
  let fieldDepth = -1;
  let buffer = '';

  let ended = false;
  let record = emptyRecord();
  const entries: SitemapEntry[] = [];
  const sitemaps: SitemapRef[] = [];
  let skipped = 0;
  let truncated = false;

  const finish = (): void => {
    const closed = record;
    record = emptyRecord();

    if (entries.length + sitemaps.length >= limits.maxEntries) {
      truncated = true;
      return;
    }

    // §5: the one normaliseUrl. A relative `<loc>` resolves against the sitemap
    // it was listed in, the same way an `href` resolves against its page —
    // `normaliseUrl` takes a `base` for exactly that, and inventing a different
    // rule for sitemaps would be a second opinion about how a document's URLs
    // resolve.
    const url = closed.loc === null ? null : normaliseUrl(closed.loc, { base });
    if (url === null) {
      // A `<url>` with no usable `<loc>` is still an entry the site listed and
      // we could not use. Counted, not silently dropped.
      skipped += 1;
      return;
    }

    if (root === 'urlset') {
      entries.push({
        url,
        lastmod: closed.lastmod,
        changefreq: closed.changefreq,
        priority: closed.priority,
      });
    } else {
      sitemaps.push({ url, lastmod: closed.lastmod });
    }
  };

  const parser = new Parser(
    {
      onopentag(name) {
        depth += 1;
        if (depth > limits.maxDepth) return;

        const local = localName(name);

        if (root === null && depth === 1) {
          if (local === 'urlset') {
            root = 'urlset';
            container = 'url';
          } else if (local === 'sitemapindex') {
            root = 'sitemapindex';
            container = 'sitemap';
          }
          return;
        }

        if (root === null) return;

        // ⚠️ THE ROOT DECIDES WHAT THE DOCUMENT IS. A `<sitemap>` inside a
        // `<urlset>` is not a container, so it is not collected. Otherwise one
        // document could be read as both forms and "is this pages or sitemaps"
        // would have two answers.
        if (depth === 2 && local === container && containerDepth === -1) {
          containerDepth = depth;
          record = emptyRecord();
          return;
        }

        if (containerDepth !== -1 && depth === containerDepth + 1 && FIELDS.has(local)) {
          field = local;
          fieldDepth = depth;
          buffer = '';
        }
      },

      ontext(text) {
        if (field === null) return;
        if (buffer.length >= limits.maxFieldLength) return;
        buffer += text;
      },

      onclosetag() {
        // ⚠️ SYNTHESISED CLOSES ARE NOT CLOSES. `parser.end()` invents a closing
        // tag for every element still open, so a document cut mid-`<loc>` would
        // otherwise be finalised as a real entry — measured, and it recorded
        // `https://abcplumbing.tes` from a severed `https://abcplumbing.test/x`.
        // That is the truncation defect dev log 0018 found in robots.txt,
        // arriving by a different route, and the comment above claiming an
        // entry is only emitted on its closing tag was false until this flag
        // existed.
        if (ended) return;

        if (field !== null && depth === fieldDepth) {
          const value = buffer.slice(0, limits.maxFieldLength).trim();
          if (value.length > 0) {
            // Assigned by name rather than by computed key: `field` is already
            // constrained to FIELDS, and an explicit switch keeps that visible
            // instead of relying on the guard three lines away.
            if (field === 'loc') record.loc = value;
            else if (field === 'lastmod') record.lastmod = value;
            else if (field === 'changefreq') record.changefreq = value;
            else if (field === 'priority') record.priority = value;
          }
          field = null;
          buffer = '';
        }

        if (containerDepth !== -1 && depth === containerDepth) {
          containerDepth = -1;
          finish();
        }

        depth -= 1;
      },
    },
    { xmlMode: true, decodeEntities: true },
  );

  parser.write(bounded);
  ended = true;
  parser.end();

  if (root === 'urlset') return { kind: 'urlset', entries, skipped, truncated };
  if (root === 'sitemapindex') return { kind: 'sitemapindex', sitemaps, skipped, truncated };
  return { kind: 'unknown', refusal: 'not_a_sitemap' };
}
