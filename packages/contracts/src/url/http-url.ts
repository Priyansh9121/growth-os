/**
 * One definition of "does this URL-ish string name an http(s) location?".
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Four functions in three packages answered that question with the same
 * four-character idiom, and it was wrong in all four:
 *
 *   const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
 *
 * ⚠️ THE PATTERN AND THE PARSER ARE NOT ASKED ABOUT THE SAME TEXT. `new URL()`
 * removes ASCII tab, LF and CR from **anywhere** in the string and maps `\` to
 * `/` before it parses. So the pattern answers a question about the raw bytes,
 * the parser then answers a different question about the cleaned ones, and the
 * prepend happens in the gap between them. Measured (dev log 0026):
 *
 * | input                | pattern | `new URL(raw)` | `new URL('https://' + raw)` |
 * | -------------------- | ------- | -------------- | --------------------------- |
 * | `https:/\evil.test`  | false   | `evil.test`    | `https`                     |
 * | `<TAB>https://e.test`| false   | `evil.test`    | `https`                     |
 * | `file:///etc/passwd` | false   | *(no host)*    | `file`                      |
 * | `mailto:a@b.test`    | false   | *(no host)*    | `b.test`                    |
 * | `/contact`           | false   | *throws*       | `contact`                   |
 *
 * Prepending **fabricates an authority** in four of those five and **destroys a
 * correct parse** in two. `normaliseOrigin`'s docstring promised "never a
 * repaired guess"; `/contact` became the origin `https://contact`.
 *
 * ⚠️ THIS IS NOT A URL NORMALISER AND MUST NOT BECOME ONE. §5's "URL identity
 * is singular" governs `normaliseUrl` in `@growth-os/crawler`, which decides
 * when two crawled pages are the same page. This decides something much
 * smaller — whether a string is an http(s) location at all — for forms, CRM and
 * site registration. Adding path, query or case folding here would create the
 * second identity that invariant exists to prevent.
 *
 * @see docs/decisions/ADR-0045-one-absolute-url-test.md
 */

/**
 * RFC 3986 §3.1: `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"`.
 *
 * Deliberately not `https?://`. The question is "is a scheme present", not "is
 * it one we like" — those are answered in sequence below, and collapsing them
 * is exactly the bug this module exists to remove.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The characters `new URL()` deletes from anywhere in its input before parsing
 * (WHATWG URL, "URL parsing", step 2). Removed here first so that every test
 * below is asked about the same text the parser will see.
 */
const STRIPPED_BEFORE_PARSING = /[\t\n\r]/g;

function parseOrNull(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function httpOrNull(url: URL | null): URL | null {
  if (url === null) return null;
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
}

/**
 * Parse a URL-ish string to an http(s) `URL`, or `null`.
 *
 * Returns `null` rather than throwing, and **rather than guessing**: every
 * caller is handling a referrer, an `Origin` header or a typed website, where a
 * malformed value is ordinary traffic that must not fail an acquisition or a
 * registration. The caller drops the field.
 *
 * ⚠️ A VALUE CARRYING A NON-HTTP SCHEME IS REFUSED, NOT REPAIRED. That includes
 * `host:port` written without a scheme — `abcplumbing.test:8080` is, per RFC
 * 3986, a scheme `abcplumbing.test` with the opaque part `8080`, and reading it
 * as a host and a port is a guess about which of two valid readings was meant.
 * The previous idiom made that guess silently. This refuses, and dev log 0026
 * measures what that costs.
 *
 * ⚠️ NO LENGTH CAP HERE, and no `'null'` sentinel check. Each caller bounds a
 * different column at a different width, and the literal `null` an opaque
 * origin sends is meaningful only to the two callers reading browser headers.
 * A cap applied twice at different widths is how callers stop agreeing.
 */
export function httpUrlOf(input: string | null | undefined): URL | null {
  if (!input) return null;

  const cleaned = input.replace(STRIPPED_BEFORE_PARSING, '').trim();
  if (cleaned.length === 0) return null;

  // A scheme is present: the parser is the only authority on what it means.
  // Anything that is not http(s) — `file:`, `mailto:`, `javascript:`, `data:`,
  // and the ambiguous scheme-less `host:port` — is refused rather than coerced.
  if (SCHEME.test(cleaned)) return httpOrNull(parseOrNull(cleaned));

  // No scheme, so the value must be a bare authority (`abcplumbing.test`,
  // `www.abcplumbing.test/contact`). A leading `/` makes it a path or a
  // protocol-relative reference, and prepending a scheme to either manufactures
  // a host out of it: `/contact` parses as the origin `https://contact`.
  if (cleaned.startsWith('/')) return null;

  return httpOrNull(parseOrNull(`https://${cleaned}`));
}

/**
 * The bare host of a URL-ish string: lowercased, `www.` removed.
 *
 * ⚠️ A URL FACT, NOT A DOMAIN RULE. Two callers in two packages had written
 * these same three lines — `referrerHost` in `@growth-os/contracts` (which
 * source a visit came from) and `normaliseWebsiteHost` in `@growth-os/crm`
 * (a weak identity key for company deduplication). They answer the same
 * question for different reasons, and the question is about URLs.
 *
 * What stays with each caller is the domain rule: that a referrer host selects
 * a source platform, and that a website host is a dedup signal. Only "what is
 * the host" is shared.
 *
 * ⚠️ `www.` IS STRIPPED HERE AND MUST NOT BE STRIPPED BY `normaliseOrigin`.
 * To a browser `https://www.x.test` and `https://x.test` are different origins,
 * so the origin path deliberately preserves the prefix. These two callers are
 * matching a site, not an origin, where a customer typing either means the
 * same company.
 */
export function bareHostOf(input: string | null | undefined): string | null {
  const url = httpUrlOf(input);
  if (url === null) return null;

  const host = url.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}
