# ADR-0066 — Link extraction is a hand-written tolerant scanner, and it delegates scope rather than deciding it

**Status:** Accepted
**Scope:** `packages/crawler/src/links/extract.ts` — the extractor, its caps,
and its relationship to `urls/scope.ts` and `urls/normalise.ts`. **No schema
changes**: `crawl_links` has existed since migration 0008 and this is the first
thing that can fill it. **Nothing is wired yet** — see "Consequences, negative".
**Date:** 2026-08-23
**Deciders:** One engineer.
**Context as of this date:** The crawler discovers pages from its seed and from
sitemaps only. `crawl_links` is written by nothing. Stage 5, the audit layer
that would interpret these facts, does not exist.

## Context

[`docs/PROJECT-STATUS.md` §7](../PROJECT-STATUS.md) names HTML link extraction
as _"the single change that most increases what this system can do: until it
exists, a crawl of a site without a sitemap returns one page, and Stage 5 has
almost no facts to interpret."_ Measured this session and confirmed: no HTML is
parsed for links anywhere in `packages/crawler`, and `crawl_links` appears in no
insert.

The `crawl_links` table already has exactly the right shape — `source_page_id`,
`target_url`, `scope`, `anchor_text`, `is_nofollow`. It was designed for this
and never filled.

## Decision

**A hand-written, single-pass, non-backtracking scanner that turns one HTML
document into link facts, delegating every URL judgement to the modules that
already own them.**

### Hand-written, not a DOM parser

The same choice `robots/parse.ts` made, for the same reasons. A strict parser
rejects the malformed markup real sites serve constantly; a crawler that
refused it would refuse most of the web. Adding `parse5` or `cheerio` would
also be the first runtime dependency in a `packages/*` workspace — every one of
them currently declares `"dependencies": {}` or internal packages only. That is
a dependency decision, not a parsing one, and it is not this brief's to make.

### ⚠️ Non-backtracking, because the input is attacker-influenced

Any site accepting comments serves attacker-controlled HTML. The scanner walks
forward with an index and never re-scans, so cost is linear in document length
whatever the document contains. A test feeds it 20,000 repetitions of `href=`
inside one tag — the shape that kills a naive regex — and asserts it completes.

### ⚠️ Scope is DELEGATED, not decided here

`urls/scope.ts` already exports `classifyScope(normalisedUrl, scope)`. This
module maps its verdict onto the `LinkScope` vocabulary and adds nothing:

| `ScopeVerdict`    | `LinkScope`       |
| ----------------- | ----------------- |
| `in_scope`        | `internal`        |
| `scheme_upgrade`  | `internal`        |
| `other_subdomain` | `other_subdomain` |
| `external`        | `external`        |

`scheme_upgrade → internal` because `http://example.test/a` linked from
`https://example.test/` is the same page of the same site; recording it as
external would put a site's own pre-TLS links in the outbound column.

**This ADR exists partly because the first draft got it wrong.** A second
`classifyScope` was written in this module — independently arriving at the same
sibling-subdomains-are-external rule — before the existing one was found. Two
functions of the same name that could disagree about what belongs to a site is
precisely what AGENTS.md §5's "URL identity is singular" forbids. The duplicate
was deleted before commit.

Scope takes the **site's** verified origin, not the page's URL: whether a link
is internal is a property of the site being crawled, not of whichever page
happened to contain the link.

### Every href goes through `normaliseUrl`

`mailto:`, `tel:`, `javascript:`, `#fragment` and unparseable strings all become
`null` there and are dropped. This module never decides for itself what a
crawlable URL is.

### Facts, not findings

"This page links to /about with the text 'About us', marked nofollow" is a fact.
"Too few internal links" is a finding and belongs to Stage 5. Nothing here
scores, ranks or recommends.

### No raw HTML leaves the module

The document is an argument, never a return value — ADR-0034's storage rule
holds by construction rather than by discipline.

### Caps

`MAX_LINKS_PER_PAGE = 5,000` and `MAX_ANCHOR_TEXT_LENGTH = 512`. A page with
more links than that is a generated index whose tail adds nothing to the graph,
and anchor text longer than 512 characters is a page inside a link. The caps are
what stop one hostile document writing unbounded rows.

### `nofollow`, `ugc` and `sponsored` are one boolean

`crawl_links.is_nofollow` is a single column and all three tokens tell a crawler
the same thing about passing weight. Splitting them needs a column that does not
exist, which is a schema decision.

## Alternatives considered

### A — Add a real HTML parser (`parse5`, `cheerio`)

Attractive: correct tree construction, spec-compliant error recovery, far less
code to own.

**Rejected for this slice.** It would be the first third-party runtime
dependency in any `packages/*` workspace, which changes the supply-chain surface
of a multi-tenant product and deserves its own ADR. The robots parser set the
precedent that this repository writes its own tolerant parsers and tests them
hostilely. Worth revisiting when a second consumer needs a real DOM.

### B — Regex-only extraction

Attractive: twenty lines.

**Rejected.** A regex cannot skip `<script>` and comment regions without
becoming a parser anyway, and a backtracking pattern over attacker-influenced
input is a denial-of-service. Both failures are covered by tests that would fail
if someone reintroduced the approach.

### C — Classify link scope inside the links module

**Rejected, after being written and caught.** See above. The reasoning it
re-derived was correct, which is exactly what makes the duplication dangerous:
two correct implementations drift on the first edit to either.

### D — Separate columns for `nofollow`, `ugc` and `sponsored`

Attractive: they are genuinely different declarations.

**Rejected for now.** It is a migration, and no consumer distinguishes them.
Naming it here so the eventual need is a decision rather than a discovery.

### E — Store the raw HTML so extraction can be re-run without re-crawling

**Rejected — it is already refused by [ADR-0034](ADR-0034-crawl-storage-model.md).**
A crawl of a 500-page site would archive every word a business published,
including customer testimonials and staff names, in a store outside erasure's
model.

## Consequences

### Positive

- A crawl of a site with no sitemap can discover more than one page — the
  single largest limit on what this system can learn.
- `crawl_links` becomes fillable, which is what makes "what links here?",
  orphan detection and internal-link counts answerable at all.
- One answer to "does this URL belong to this site", shared with the frontier.
- Extraction is pure and synchronous: no network, no database, no clock. It is
  tested entirely on committed synthetic fixtures.

### Negative

- **Nothing calls it.** This slice is the extractor and its tests. Wiring it
  into `fetchPage`, persisting to `crawl_links` and enqueuing discovered
  internal links into the frontier is a separate slice and is **not done**.
  Until then a crawl still returns one page for a sitemap-less site.
- **`<a href>` only.** No `<link rel>`, no `<area>`, no canonical, no
  `<iframe src>`. Those are different facts with different meanings and some
  belong in different columns.
- **No JavaScript.** A site that renders its navigation client-side still
  yields nothing. That is a headless-browser decision far beyond this slice.
- **Sibling subdomains classify as `external`**, inherited from `urls/scope.ts`.
  Correct without a public suffix list, and the safe direction, but it will
  under-report internal linking for businesses that split `www` and `shop`.
- **A hand-written scanner is code we own forever.** Every malformed-markup
  case the web invents is now our bug.

### Risks and mitigations

| Risk                                                     | Mitigation                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A pathological document makes extraction quadratic       | Forward scan with no backtracking; a 20,000-`href=` test asserts completion under five seconds.                 |
| One page writes unbounded rows                           | `MAX_LINKS_PER_PAGE`, asserted by a test that feeds it more.                                                    |
| Someone re-derives scope locally, as the first draft did | The mapping table is a four-line function with an ADR paragraph attached, and the test names `urls/scope.ts`.   |
| Extraction drifts from `normaliseUrl`                    | It has no URL parsing of its own; `mailto:`/`javascript:`/fragment handling is asserted through the public API. |
| Anchor text carries markup into the database             | Tags are stripped and entities decoded before capping; tested with nested markup.                               |

## Revisit when

- **The wiring slice lands.** Persisting links and enqueuing internal ones is
  where the caps, the scope mapping and the frontier interact for the first
  time, and where this ADR's assumptions get their first real test.
- **A second consumer needs a DOM** — canonical tags, `hreflang`, structured
  data. That is the moment alternative A stops being over-engineering.
- **A customer's internal linking is visibly under-reported** because their site
  spans sibling subdomains. That is the evidence that would justify a public
  suffix list, which is a dependency decision for `urls/scope.ts`, not here.
