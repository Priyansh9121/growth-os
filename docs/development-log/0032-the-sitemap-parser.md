# 0032 — The sitemap parser, and a safety comment that shipped before the code

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Sitemap fetching and parsing in `packages/crawler/src/sitemap`, test-first, from
scratch. The first new crawler parser since robots.txt, and the first XML the
crawler touches.

## Initial state

Verified, not recalled: `ec73aad`, tree clean, `verify:all` exit 0 at **1155
passed / 230 skipped (1385)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## XXE — measured before choosing anything

The brief was explicit that "we didn't write a DOCTYPE handler" is not the whole
argument, so each claim below is a measurement or a read of the library, not an
inference:

| probe                                           | result                             |
| ----------------------------------------------- | ---------------------------------- |
| `<!ENTITY xxe SYSTEM "file:///etc/passwd">`     | literal `&xxe;`, no file content   |
| `<!ENTITY x SYSTEM "http://169.254.169.254/…">` | literal `&x;`, no request          |
| billion laughs, 9 levels, 809 bytes             | **29 bytes out**, 0.04×, 0.14 ms   |
| `&amp;`                                         | decodes to `&` — needed, see below |
| `grep fs\|http` over `htmlparser2/dist`         | no references                      |
| `ParserOptions` surface                         | 7 options, none entity-related     |

`htmlparser2` v12 with `{ xmlMode: true, decodeEntities: true }`. Already a
direct dependency of `@growth-os/crawler`; no new one. The safety is
**structural** — there is no entity-declaration mechanism to configure, and
`decodeEntities` is a static table via the `entities` package that document
content cannot extend. That is why an undeclared `&xxe;` stays literal while
`&amp;` decodes — and decoding is required for **correctness**, because `&amp;`
is how every real sitemap writes a query separator.

⚠️ **The XXE assertions have a measured premise.** `/etc/passwd` is read in the
test and asserted non-empty and containing `root:` **before** any absence is
claimed. Without that control, "the output does not contain `root:`" would pass
just as happily against a parser that resolved the entity and found nothing
there. The billion-laughs test asserts the **output is smaller than the input**,
which a resolving parser cannot satisfy.

## ⚠️ The finding: a safety comment that shipped before the code that made it true

Truncation here drops entries and can never invent one — the opposite of the
robots.txt truncation defect dev log 0018 measured, where a severed `Allow`
**granted** access. The property that makes it true is that an entry is emitted
on its closing tag, so a cut inside `<url>…</url>` records nothing.

I wrote that in the docstring. It was false.

`parser.end()` **synthesises a closing tag for every element still open**, so a
document cut mid-`<loc>` was finalised as a real entry: a severed
`https://abcplumbing.test/x` became **`https://abcplumbing.tes`** — a different
host, invented by the parser, from a document that never named it.

An `ended` flag now suppresses synthesised closes, and the docstring says the
qualifier is load-bearing.

⚠️ **The first version of the test did not catch it either**, which is the
part worth keeping. The fixture was built with a helper that appends
`</urlset>`, so the document was well-formed enough for the parser to emit
_real_ closes — the assertion passed against the bug. Tracing the actual event
stream (`write()` vs `end()`) is what separated them. A test whose fixture does
not reproduce the condition is a test that certifies the defect.

Two other bugs the tests caught: `finish()` reset the record **before** reading
`lastmod`/`changefreq`/`priority`, so every optional field was null; and a
`<url>` with no usable `<loc>` was dropped without being counted as skipped.

## Fail-open, and why the robots precedent does not transfer

ADR-0035 fails **closed** on an unreadable `robots.txt`. Copying that here would
have been the easy mistake — a new parser landing beside an existing one is
exactly when a precedent gets applied without re-deriving it.

**A sitemap grants nothing.** It is the site's own list of pages, an
optimisation over following links. The robots argument turns on _"we could not
read robots.txt" is not "robots.txt permits this"_; the sitemap equivalent is
not a sentence, because a sitemap never permitted anything. Most sites do not
publish one, so treating absence as robots' absence is treated would make most
of the web uncrawlable.

`siteDisallowed` is typed as the literal `false`, so the compiler enforces it,
and a property test loops every branch rather than trusting a reader to check
each. 401/403 diverge from robots deliberately — ADR-0051 argues it.

## gzip, and the bound that is the only one that applies

`safeFetch` decompresses on `content-encoding` (verified at `fetch.ts:418`).
`sitemap.xml.gz` is a _file_ served as `application/gzip` with **no**
`content-encoding`, so those bytes never reach the decompressed tier. This
module inflates them, detecting the `1f 8b` magic number rather than trusting a
content type.

`gunzipSync(body, { maxOutputLength })` aborts rather than allocating — measured
throwing `ERR_BUFFER_TOO_LARGE`. Without it the wire cap would be no bound at
all for `.gz`: 64 MB compresses to well under it. Not a §5 fast path — the
request is complete, both transport tiers have applied, and `node:zlib` opens no
socket and is not among the crawler's forbidden imports (checked, not assumed).

## Files

```
packages/crawler/src/sitemap/parse.ts        parseSitemap, DEFAULT_SITEMAP_LIMITS
packages/crawler/src/sitemap/parse.test.ts   31 tests
packages/crawler/src/sitemap/fetch.ts        fetchSitemap
packages/crawler/src/sitemap/fetch.test.ts   20 tests
packages/crawler/src/index.ts                exports
docs/decisions/ADR-0050-sitemap-parsing.md
docs/decisions/ADR-0051-sitemap-fetch-is-fail-open.md
docs/development-log/0032-the-sitemap-parser.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Testing

**51 new tests** — 31 parsing, 20 fetching. Both files were written and observed
red before their implementations existed (§2).

`verify:all` exit 0: **1,206 passed / 230 skipped (1,436)**, against 1,155 / 230
(1,385) at the start. 29 boundary probes.

No migration was touched (0 files under `packages/database/migrations`), so §7.2
has nothing to apply.

## Result

The crawler can read a site's own list of pages. Both sitemap forms parse, both
gzip conventions work, and no external entity is ever resolved — proven against
a fixture that would leak readable file content if one were.

**The lesson is the one this project keeps relearning, arriving by a new route.**
Three sessions ago a dev log's recorded table needed re-measuring. This time it
was my own docstring, written from reading the code I had just written, asserting
a property the code did not have — and the first test I wrote for it passed
anyway, because the fixture did not reproduce the condition. §1 says source-level
reasoning proposes and a measurement decides; the corollary this session adds is
that **a test only decides if its fixture is the thing you think it is.**

## Remaining work

The next brief is the frontier: queueing what a sitemap discovered. This
produces a list of URLs and deliberately stops there.

⚠️ Explicitly not done here, and not defects:

- **Child sitemaps in an index are not fetched.** `fetchSitemap` returns the
  list; following it is recursion with its own budget, cycle and depth
  questions, and belongs with the frontier.
- **A sitemap entry has not passed admission.** It is a URL a stranger wrote —
  not checked against the SSRF pipeline, robots rules or crawl scope. That
  happens at admission, exactly as for a URL found in a link, and duplicating it
  in the parser would be the second path §5 forbids.
- **`lastmod` is not parsed into a date**, and `priority` is not read as a
  number. Both are stored as written: they are the site's claims, and
  interpreting them is Stage 5's job.

Carried, unchanged: the local dev database at migration 0007, the permanently
deferred client-side email regex, and 0030's open question about whether the 4×
expansion ratio should be a constraint rather than a convention.
