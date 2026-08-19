# ADR-0050 — Sitemap parsing: htmlparser2 in XML mode, and why truncation is safe here

**Status:** Accepted
**Date:** 2026-08-19

## Context

XML is the most dangerous format the crawler touches. An XML parser that
resolves external entities reads local files and dials internal addresses on
behalf of whoever wrote the document — a file-disclosure and SSRF primitive
delivered as a sitemap. §5 says SSRF defence is structural; a parser that can be
asked to fetch is a hop nobody put in the pipeline.

## Decision 1 — `htmlparser2` v12, `{ xmlMode: true, decodeEntities: true }`

Already a direct dependency of `@growth-os/crawler` (and of `@growth-os/sites`,
where ADR-0037 chose it for verification). No new dependency.

### ⚠️ The safety is structural, not a flag that was turned off

This distinction is the whole argument, because a _compliant_ XML parser can
usually be asked to resolve entities and the default is often "yes". Each of
these was measured or read this session, not assumed:

- **There is no entity-declaration mechanism at all.** `<!DOCTYPE …>` is
  reported as a processing instruction and never interpreted. Measured: a
  document declaring `<!ENTITY xxe SYSTEM "file:///etc/passwd">` and referencing
  `&xxe;` produced the literal text `&xxe;` — no file content, no `root:`.
- **`decodeEntities` is a static table, not a resolver.** It decodes the fixed
  HTML/XML named and numeric entities via the `entities` package. Document
  content cannot extend that table, which is why an undeclared `&xxe;` stays
  literal while `&amp;` decodes.
- **The library performs no I/O.** `grep` over its distribution finds no `fs` or
  `http` reference, so `SYSTEM "file:///…"` has nothing to call even if a
  declaration were honoured.
- **No option enables any of it.** The complete option surface is `xmlMode`,
  `decodeEntities`, `lowerCaseTags`, `lowerCaseAttributeNames`,
  `recognizeCDATA`, `recognizeSelfClosing`, `Tokenizer`. Only the last could
  change tokenisation, and it is not passed.

`decodeEntities: true` is required for **correctness**, not convenience: `&amp;`
is how every real sitemap writes a query separator, and a `<loc>` read without
decoding produces the wrong URL.

### Billion laughs

Measured: the classic nine-level payload, 809 bytes in, produced **29 bytes** of
text out — an expansion factor of 0.04×, in 0.14 ms. There is nothing to expand
because there is nothing to declare. The test asserts the output is _smaller
than the input_, which is a property a resolving parser cannot satisfy.

### Alternatives

**A real XML parser (`saxes`, `fast-xml-parser`, `libxmljs`).** Rejected: each
adds a dependency to get a stricter grammar the crawler does not need, and the
stricter ones are exactly the ones with entity machinery to configure off. The
risk being avoided is _having_ the feature.

**Writing a tolerant scanner by hand.** Rejected on §2 grounds — a hand-rolled
parser over hostile input is the class of output this project has already
deleted once.

## Decision 2 — ⚠️ truncation drops entries and can never invent one

Both caps (`maxBytes`, `maxEntries`) **truncate rather than refuse**. A sitemap
over 50,000 URLs is a large site, not an attack, and refusing the document would
lose every URL to punish the last one.

That is the opposite of the call ADR-0040 had to make for robots.txt, and the
asymmetry is the reason: dev log 0018 measured a severed `Allow: /private-public`
becoming `Allow: /private`, so robots truncation **granted** access. A severed
sitemap entry grants nothing — it is one fewer page discovered.

The property that makes it true: **an entry is emitted on its real closing tag.**
A cut inside `<url>…</url>` means the element never closes and nothing is
recorded.

### ⚠️ That claim was false when it was first written, and a test caught it

`parser.end()` synthesises a closing tag for every element still open. A
document cut mid-`<loc>` was therefore finalised as a real entry: a severed
`https://abcplumbing.test/x` was recorded as **`https://abcplumbing.tes`** — a
different host, invented by the parser, from a document that never named it.

An `ended` flag now suppresses synthesised closes. Recorded here rather than
quietly fixed because the docstring asserting the safety property shipped
_before_ the code had it, which is precisely the failure mode §1 warns about:
a conclusion inferred from reading code rather than measured.

⚠️ **The first version of the test did not catch it either.** It built the
fixture with a helper that appends `</urlset>`, so the document was
well-formed enough for the parser to emit _real_ closes — the test passed
against the bug. It now cuts without a closing root, which is what a byte cap
actually produces.

## Decision 3 — the root element decides what the document is

A `<sitemap>` inside a `<urlset>` is not collected, and a `<url>` inside a
`<sitemapindex>` is not either. Otherwise one document could be read as both
forms, and "is this a list of pages or a list of sitemaps" would have two
answers — the shape §5's URL-identity invariant exists to prevent, applied one
level up.

## Decision 4 — a relative `<loc>` resolves against the sitemap's own URL

sitemaps.org says `<loc>` MUST be absolute. Real sitemaps are not always, and
`normaliseUrl` already takes a `base` for exactly this case — its own docstring
says "supplied whenever a URL came out of a document — an anchor, a canonical
tag, a `Location` header". A sitemap `<loc>` is a URL out of a document.

Inventing a stricter rule _only_ for sitemaps would be a second opinion about
how a document's URLs resolve, which is the shape §5 forbids.

⚠️ **The cost, stated:** inert text becomes a nonsense URL. A `<loc>` containing
an unresolved `&xxe;` resolves to `https://site/&xxe;` and is recorded as an
entry. That is harmless — admission refuses it like any other URL — but it is
noise, and the test pins it so that a future change which started resolving
entities would have to change that assertion too. The absence-of-`root:`
assertions alone would still pass if the file were empty.

## Decision 5 — facts, not findings

`lastmod`, `changefreq` and `priority` are stored as **strings, exactly as
written**, unparsed and uninterpreted. `priority` is the site's own claim about
what matters; storing the claim is a fact, ordering a crawl by it is a
judgement, and §5 puts judgement in the frontier and Stage 5 — not here.

Parsing them would also mean deciding what an invalid value means, which is the
same judgement wearing a different hat.

## Consequences

### Positive

- No external entity is ever resolved, proven against a fixture that would leak
  readable file content if it were.
- Truncation can only lose pages, never invent one — now actually true.
- One `normaliseUrl`, so a sitemap cannot disagree with the frontier.

### Negative

- **Tolerant parsing accepts nonsense.** `htmlparser2` is not a validating XML
  parser; malformed documents yield whatever was well-formed enough to read,
  and a `<loc>` of inert text becomes a URL. Admission is what refuses it.
- **The XXE argument depends on a library's internals**, not on a configuration
  this repository controls. If `htmlparser2` ever grew entity support, the
  measured tests would catch it — but only because they exist, not because the
  API would change.
- **`maxBytes` and `maxEntries` interact.** At the defaults, a 60,000-entry
  document hits the 2 MB byte cap at ~39,800 entries, so the entry ceiling is
  not the binding one for large files. Both are tested separately, and the
  entry-cap test raises `maxBytes` deliberately so it is not silently measuring
  the wrong limit.

## Verification

**31 tests** in `packages/crawler/src/sitemap/parse.test.ts`, mostly hostile
input: external entity to a local file, external entity to link-local metadata,
nine-level billion laughs, DOCTYPE subset leakage, 5,000-deep nesting, 60,000
entries, a truncated document, a BOM, a lying encoding declaration, a
replacement character, non-sitemap XML, an HTML page, and an empty document.

The XXE assertions have a **measured premise**: `/etc/passwd` is read in the
test and asserted non-empty and containing `root:` before any absence is
claimed. Without that control, "the output does not contain `root:`" would pass
against a parser that resolved the entity and found nothing.

`verify:all` exit 0 at **1,186 passed / 230 skipped (1,416)**, against 1,155 /
230 (1,385) at `ec73aad`. 29 boundary probes.
