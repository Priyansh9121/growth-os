# ADR-0037 — Verification matches a parsed document, not a pattern

**Status:** Accepted
**Date:** 2026-08-17

## Context

`findMetaToken` decided whether a domain may be crawled. It was a regular
expression over raw HTML:

```
<meta[^>]*\bname\s*=\s*["']?growth-os-verification["']?[^>]*\bcontent\s*=\s*["']?([0-9a-fA-F]{32})["']?
```

Adversarial probing — sixteen agents, ~250 executed cases, four independent
angles, every claim reproduced — found **32 distinct inputs that returned a token
no browser would consider published**, plus quadratic backtracking.

### The worst case needed no injection flaw

The payload `name=growth-os-verification content=<token>` contains no `<`, `>`,
`"` or `'`. Measured: `escape(payload) === payload` under standard HTML escaping.

So it does not need to become a tag — it only needs to land inside an _existing_
tag's attribute value. Verified returning the token:

```html
<meta
  name="description"
  content="12 results for name=growth-os-verification content=0123…"
/>
<meta
  property="og:title"
  content="Search: name=growth-os-verification content=0123…"
/>
```

**Any homepage that reflects a search term into its meta description or Open
Graph tags could verify a domain the requester does not own.** That is standard
behaviour on e-commerce, CMS and search pages.

### Two structural causes in one line

1. **The optional closing quote `["']?`** made the name a _prefix_ match, so
   `growth-os-verification-other` matched: with the quote unmatched, `[^>]*`
   swallowed the rest of the value and walked on to `content=`.
2. **No tag or attribute boundaries.** `<meta` matched `<metadata>` and
   `<meta-box>`; `\bname` matched `data-name` and `xml:name`, because `-` and
   `:` are word boundaries.

Neither is fixable by tightening the pattern, because the third cause is the
approach: **a pattern over text cannot know what a comment, a `<textarea>` or an
attribute value is.**

### And it backtracked quadratically

Measured on `'<meta ' + 'name=growth-os-verification '.repeat(n)`:

| Input   | Old (regex) | New (parse) |
| ------- | ----------- | ----------- |
| 70 KB   | 88 ms       | **2 ms**    |
| 140 KB  | 395 ms      | **3 ms**    |
| 280 KB  | 1,642 ms    | **6 ms**    |
| 560 KB  | 5,973 ms    | **7 ms**    |
| 1.12 MB | ~20,000 ms  | **14 ms**   |

The caller accepts 1 MB bodies, so a page the requester chose blocked the
verification worker for roughly twenty seconds per attempt. Same class as the
robots pattern matcher — which is a two-pointer scan for exactly this reason, in
this repository, written by the same hand. **The discipline existed and was not
applied uniformly.**

## Decision

**Parse the document. Accept a token only from a real `<meta>` element in
`<head>`, with `name` exactly equal and `content` exactly 32 hex after trimming.**

`htmlparser2` becomes a **direct dependency of `@growth-os/sites`.**

### ⚠️ Not shared with `@growth-os/crawler`'s extractor

They answer different questions. The extractor gathers facts about a page for
later interpretation; this decides whether crawling is permitted at all.

Coupling them means **every future change to fact extraction touches the code
that decides whether crawling is permitted.** A new heading rule should not be
able to alter a permission boundary, and a reviewer of an extraction change
should not have to know that it can. The duplicated dependency is the cheaper
half of that trade.

### What the parser gives for free

| Old false positive                                | Why it is now impossible                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| HTML comment, `<script>`, `<style>`, `<textarea>` | The tokenizer reports no elements inside them                                 |
| `<template>`, `<svg>`, `<math>`                   | Named inert containers — `<template>` in `<head>` defeats position on its own |
| `<metadata>`, `<meta-box>`                        | Tag name compared exactly                                                     |
| `data-name`, `xml:name`                           | Attribute name compared exactly                                               |
| `growth-os-verification-other`                    | Attribute _value_ compared exactly                                            |
| Reflection into any other tag's attribute         | An attribute value is never markup                                            |
| A 33-character or longer hex string               | `content` must be exactly 32 hex                                              |

⚠️ `<script>`/`<style>`/`<textarea>` are deliberately **absent** from the inert
list: the protection is the tokenizer, not the list, and listing them would
misattribute it. A test asserts the mechanism.

## Three deliberate behaviour changes

### 1. `<head>` only — a TIGHTENING

A tag in `<body>` verified before and does not now.

`<head>` is where the instructions tell the operator to put it, and **body
content is far more likely to be user-generated** — a comment, a review, a search
echo. Restricting to `<head>` removes the largest class of pages where an
attacker can place bytes.

### 2. `content` is trimmed — a LOOSENING

`content=" TOKEN "` returned null and now verifies.

CMS fields pad whitespace, and the token must still be exactly right, so this
widens nothing an attacker can use. It removes a support call whose cause was
invisible to the operator.

### 3. Every published token is considered, not the first — a FIX

The regex returned the first match. A page carrying a **stale** token followed by
the current one failed verification while visibly displaying the correct proof —
and rotation makes exactly that page normal, because an operator adds the new tag
before removing the old one.

`findMetaTokens` returns all of them; the caller checks membership.

## Blast radius: nil, and measured

- `0 verified / 0 sites` in both local databases.
- **`verifySite`, `issueVerificationToken` and `findMetaToken` had no callers
  outside `packages/sites`** — no API route, no worker, no UI. The function was
  never reachable by an operator.

So this is a latent defect in unreleased code, not an incident. No migration, no
re-verification sweep, nobody to notify — and the `<head>` tightening breaks
nothing that exists.

## Checked and NOT changed

**`checkDnsTxt` does not have this defect.** It compares with `===` against a
fully-constructed expected string, over discrete records the resolver returns.
No pattern, no substring, no surrounding document.

It does accept either `growth-os-verification=<token>` or the bare token — a
loosening for providers that strip the prefix, currently undocumented. Recorded
here as an observation for its own brief; not touched.

## Alternatives considered

**Tighten the regex.** Anchoring the quote and adding boundaries would fix the
prefix match and the `data-name` class, and would not fix comments, `<script>`,
`<textarea>`, or attribute-value reflection — because those need structure. It
would also leave the backtracking.

**Share the crawler's extractor.** Rejected above.

**A hand-rolled scan, as the robots matcher is.** Defensible, and the robots
matcher exists because robots.txt has no parser worth depending on. HTML does.
Writing a second HTML tokenizer to avoid one dependency is the trade in the wrong
direction.

**Require DNS only, and drop HTML verification.** Removes the surface entirely
and excludes every customer on a hosted platform who cannot edit DNS
([ADR-0031](ADR-0031-site-verification.md)) — most of them.

## Consequences

### Positive

- All 32 confirmed false positives are structurally impossible, not filtered.
- Linear time: 1.12 MB in 14 ms against ~20 s.
- Rotation works the way operators actually perform it.

### Negative

- `htmlparser2` in a second package. Accepted, and the reason is recorded above.
- `<head>`-only will refuse a tag some operator put in `<body>`. The instructions
  say `<head>`; the failure message says the tag was not found, which is
  _technically true and unhelpful_ — see below.

## ⚠️ A separate defect found while testing, and NOT fixed

A homepage returning **500 or 404 reports `token_absent`** — "we could not find
the verification tag" — because `safeFetch` returns `ok: true` for an HTTP error
status and the body is empty.

That sends an operator who placed the tag correctly looking for a mistake they
did not make. The honest message is "we could not read your homepage".

Not fixed here: it is a behaviour change to the permission boundary and belongs in
its own brief (§3). The test asserts the current behaviour with the concern named,
rather than asserting the desired behaviour and failing.

## Verification

**96 unit tests, 10 integration tests** against a real database as the restricted
non-owner role.

Every one of the 32 confirmed false positives asserts `[]`. Legitimate cases kept:
both quote styles, unquoted values, reversed attribute order, extra attributes,
self-closing, uppercase attributes and hex, mixed-case meta name, newlines and
tabs inside the tag. Hostile input: 1 MB with the tag last, 50,000 unrelated meta
tags, unclosed tags, 5,000-deep nesting, a BOM, a null byte, 90% comments, an
empty document. Timing asserted at over 1 MB inside the test.

Integration: issuing, capability refusals, the `verified_at` + method CHECK,
`seo.site.verified` published once, a failed attempt still recording
`verification_checked_at`, rotation invalidating the old token, rotation _not_
un-verifying a verified site, and a cross-tenant issue attempt refused as _not
found_ rather than _forbidden_.

## Related

- [ADR-0031](ADR-0031-site-verification.md) — why verification gates crawling
- [ADR-0032](ADR-0032-crawler-network-security.md) — the same "structural, not a check" reasoning
- [ADR-0035](ADR-0035-robots-and-politeness.md) — the two-pointer matcher this should have followed
