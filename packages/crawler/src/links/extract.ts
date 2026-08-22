/**
 * Link extraction — the facts an HTML document states about where it points.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn one HTML document into the set of links it contains. Until this existed
 * a crawl discovered pages only from its seed and its sitemap, so a site
 * without a sitemap yielded a one-page crawl and `crawl_links` was never
 * written by anything.
 *
 * ⚠️ FACTS, NOT FINDINGS (AGENTS.md §5).
 * "This page links to /about with the text 'About us', marked nofollow" is a
 * fact. "This page has too few internal links" is a finding, and belongs to the
 * audit layer. Nothing here scores, ranks or recommends.
 *
 * ⚠️ NO RAW HTML LEAVES THIS MODULE (ADR-0034).
 * The document is an argument, never a return value. What comes back is the
 * extracted facts and nothing else.
 *
 * ⚠️ URL IDENTITY IS SINGULAR (AGENTS.md §5).
 * Every href goes through `normaliseUrl`. Nothing here parses or canonicalises
 * a URL itself, so the frontier and the link graph cannot disagree about what
 * "the same page" means.
 *
 * ⚠️ HAND-WRITTEN, TOLERANT SCANNER — NOT A DOM PARSER, AND NOT A REGEX SOUP.
 * The same choice the robots parser made, for the same reasons. A strict parser
 * rejects the malformed markup that real sites serve constantly, and a
 * backtracking regex over attacker-influenced input is a denial-of-service
 * waiting to happen. This is a forward scan with no backtracking: cost is
 * linear in document length, whatever the document contains.
 *
 * @see docs/decisions/ADR-0066-html-link-extraction.md
 */

import type { LinkScope } from '@growth-os/contracts';
import { normaliseUrl } from '../urls/normalise';
import { classifyScope, type CrawlScope } from '../urls/scope';

/**
 * Most links recorded from one document.
 *
 * A page with more than this is a generated index, and the tail adds nothing
 * to the link graph that the first few thousand did not. The cap is what stops
 * one hostile document from writing unbounded rows.
 */
export const MAX_LINKS_PER_PAGE = 5_000;

/** Anchor text is a label, not content. Longer than this is a page in a link. */
export const MAX_ANCHOR_TEXT_LENGTH = 512;

export interface ExtractedLink {
  /** Normalised, absolute. Never a raw href. */
  readonly targetUrl: string;
  readonly scope: LinkScope;
  /** Plain text, collapsed and capped. `null` when the anchor had no text. */
  readonly anchorText: string | null;
  readonly isNofollow: boolean;
}

export interface ExtractLinksOptions {
  readonly maxLinks?: number;
  readonly maxAnchorTextLength?: number;
}

/** Regions whose contents are not document text and never contain live links. */
const OPAQUE_ELEMENTS: readonly string[] = ['script', 'style', 'template', 'noscript', 'svg'];

/**
 * `rel` tokens that mean "do not treat this as an endorsement".
 *
 * `ugc` and `sponsored` are folded into `isNofollow` deliberately: the schema
 * records one boolean, and all three tell a crawler the same thing about
 * whether to pass weight. Splitting them would need a column that does not
 * exist, which is a schema decision and not this module's to make.
 */
const NOFOLLOW_TOKENS: ReadonlySet<string> = new Set(['nofollow', 'ugc', 'sponsored']);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/**
 * Decode the entities that appear in hrefs and anchor text.
 *
 * ⚠️ `&amp;` in a query string is the common case, not an edge case: valid HTML
 * requires it, so `?a=1&amp;b=2` is what a correct document contains. Failing
 * to decode it would make every multi-parameter URL a different URL from the
 * one the server serves.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body: string) => {
    const lower = body.toLowerCase();
    const named = NAMED_ENTITIES[lower];
    if (named !== undefined) return named;

    if (lower.startsWith('#')) {
      const hex = lower.startsWith('#x');
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      // Reject non-characters rather than emitting U+FFFD noise into a URL.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }

    return match;
  });
}

/** Collapse markup-adjacent whitespace into single spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function isAsciiLetter(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

/**
 * Map the crawler's scope verdict onto the link-graph vocabulary.
 *
 * ⚠️ THIS IS A TRANSLATION, NOT A SECOND CLASSIFIER.
 * `classifyScope` in `../urls/scope` is the single answer to "does this URL
 * belong to this site" — including the decision that sibling subdomains are
 * `external`, because recognising them needs a registrable domain and
 * `blog.example.com` is emphatically NOT the same owner on `wordpress.com`,
 * `myshopify.com` or `github.io`, which are exactly the hosts small businesses
 * use. Re-deriving that here would give the frontier and the link graph two
 * answers to the same question (AGENTS.md §5).
 *
 * `scheme_upgrade` maps to `internal`: `http://example.test/a` linked from
 * `https://example.test/` is the same page of the same site, and recording it
 * as external would put a site's own pre-TLS links in the outbound column.
 */
function linkScopeOf(normalisedUrl: string, scope: CrawlScope): LinkScope {
  const verdict = classifyScope(normalisedUrl, scope);
  if (verdict === 'in_scope' || verdict === 'scheme_upgrade') return 'internal';
  if (verdict === 'other_subdomain') return 'other_subdomain';
  return 'external';
}

interface TagAttributes {
  readonly href: string | null;
  readonly rel: string | null;
}

/**
 * Read attributes from inside a tag, starting after the element name.
 *
 * Returns the index just past the tag's closing `>`. Handles double-quoted,
 * single-quoted and unquoted values, because all three appear in the wild.
 */
function readAttributes(html: string, start: number): { attrs: TagAttributes; end: number } {
  let index = start;
  let href: string | null = null;
  let rel: string | null = null;

  while (index < html.length) {
    const char = html[index]!;

    if (char === '>') return { attrs: { href, rel }, end: index + 1 };
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    // A stray `/` before `>` in `<a href="x" />`.
    if (char === '/') {
      index += 1;
      continue;
    }

    let nameEnd = index;
    while (nameEnd < html.length && !/[\s=>]/u.test(html[nameEnd]!)) nameEnd += 1;
    const name = html.slice(index, nameEnd).toLowerCase();
    index = nameEnd;

    while (index < html.length && /\s/u.test(html[index]!)) index += 1;

    let value = '';
    if (html[index] === '=') {
      index += 1;
      while (index < html.length && /\s/u.test(html[index]!)) index += 1;

      const quote = html[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const close = html.indexOf(quote, index);
        // An unterminated quote runs to the end of the document rather than
        // swallowing the scanner into an infinite loop.
        const stop = close === -1 ? html.length : close;
        value = html.slice(index, stop);
        index = stop + 1;
      } else {
        const valueStart = index;
        while (index < html.length && !/[\s>]/u.test(html[index]!)) index += 1;
        value = html.slice(valueStart, index);
      }
    }

    // First occurrence wins, matching how browsers treat duplicate attributes.
    if (name === 'href' && href === null) href = value;
    if (name === 'rel' && rel === null) rel = value;
  }

  return { attrs: { href, rel }, end: index };
}

/** Skip an opaque element's contents entirely. Returns the index past it. */
function skipOpaque(html: string, tagName: string, afterOpenTag: number): number {
  const close = html.toLowerCase().indexOf(`</${tagName}`, afterOpenTag);
  if (close === -1) return html.length;
  const gt = html.indexOf('>', close);
  return gt === -1 ? html.length : gt + 1;
}

/**
 * Extract every link an HTML document states.
 *
 * `baseUrl` is the URL the document was fetched from — the page's own final
 * URL after redirects, not its requested URL, or every relative href resolves
 * against a location the content never saw.
 *
 * `scope` is the SITE's verified origin, which is a different thing from the
 * page's URL: whether a link is internal is a property of the site being
 * crawled, not of whichever page happened to contain the link.
 */
export function extractLinks(
  html: string,
  baseUrl: string,
  scope: CrawlScope,
  options: ExtractLinksOptions = {},
): ExtractedLink[] {
  const maxLinks = options.maxLinks ?? MAX_LINKS_PER_PAGE;
  const maxAnchor = options.maxAnchorTextLength ?? MAX_ANCHOR_TEXT_LENGTH;

  const links: ExtractedLink[] = [];
  const lower = html.toLowerCase();

  /**
   * `<base href>` overrides the resolution base for the whole document.
   * The FIRST one wins, per the HTML spec, and a later one is ignored — a
   * document with two is malformed and browsers take the first.
   */
  let effectiveBase = baseUrl;
  let baseResolved = false;

  let index = 0;
  while (index < html.length && links.length < maxLinks) {
    const open = html.indexOf('<', index);
    if (open === -1) break;

    // Comments: skip wholesale. A commented-out link is not a link.
    if (lower.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }

    const nameStart = open + 1;
    if (nameStart >= html.length || !isAsciiLetter(html[nameStart]!)) {
      index = open + 1;
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < html.length && !/[\s/>]/u.test(html[nameEnd]!)) nameEnd += 1;
    const tagName = lower.slice(nameStart, nameEnd);

    if (OPAQUE_ELEMENTS.includes(tagName)) {
      const { end } = readAttributes(html, nameEnd);
      index = skipOpaque(html, tagName, end);
      continue;
    }

    if (tagName === 'base' && !baseResolved) {
      const { attrs, end } = readAttributes(html, nameEnd);
      if (attrs.href !== null) {
        const resolved = normaliseUrl(decodeEntities(attrs.href), { base: baseUrl });
        if (resolved !== null) {
          effectiveBase = resolved;
          baseResolved = true;
        }
      }
      index = end;
      continue;
    }

    if (tagName !== 'a') {
      const { end } = readAttributes(html, nameEnd);
      index = end;
      continue;
    }

    const { attrs, end } = readAttributes(html, nameEnd);
    index = end;

    // Anchor text runs to the closing tag. An unclosed `<a>` takes the rest of
    // the document, which is what a browser renders, so it is what we record.
    const closeIndex = lower.indexOf('</a', index);
    const textEnd = closeIndex === -1 ? html.length : closeIndex;
    const rawText = html.slice(index, textEnd);
    if (closeIndex !== -1) index = textEnd;

    if (attrs.href === null) continue;

    const targetUrl = normaliseUrl(decodeEntities(attrs.href), { base: effectiveBase });
    // `null` is a mailto:, javascript:, #fragment, or something unparseable —
    // all of which are real hrefs and none of which is a crawlable page.
    if (targetUrl === null) continue;

    const anchorText = collapse(decodeEntities(rawText.replace(/<[^>]*>/gu, ' ')));
    const relTokens = (attrs.rel ?? '').toLowerCase().split(/\s+/u).filter(Boolean);

    links.push({
      targetUrl,
      scope: linkScopeOf(targetUrl, scope),
      anchorText: anchorText.length > 0 ? anchorText.slice(0, maxAnchor) : null,
      isNofollow: relTokens.some((token) => NOFOLLOW_TOKENS.has(token)),
    });
  }

  return links;
}
