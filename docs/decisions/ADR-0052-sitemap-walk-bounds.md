# ADR-0052 — Walking a sitemap tree: three bounds, and no second admission path

**Status:** Accepted
**Date:** 2026-08-19

## Context

`packages/crawler/src/sitemap` reads one document. A `sitemapindex` lists other
sitemaps, which may list others, and a site controls every one of those links —
so following them is unbounded recursion over attacker-supplied input unless
something stops it.

Separately, those URLs have to become crawl work, and the frontier already
decides that for URLs found in links.

## ⚠️ Re-measured first: the precedent already existed

The brief asked whether a sitemap-discovered URL could be distinguished in what
the frontier stores, and whether a new field was needed. **No new field.**

- `DiscoverySource` in `decide.ts:37` already reads
  `'seed' | 'link' | 'sitemap' | 'redirect'`. `'sitemap'` predates this work.
- `Candidate` is `{ url, base?, depth, source }` — a raw URL and a source. It
  already accepts exactly what a sitemap walk produces.
- `crawl_frontier.discovery_source` already stores it.

Nothing was invented. This is the negative result the re-measurement produced,
and it is the reason this ADR is short on schema and long on bounds.

## Decision 1 — three bounds, each stopping a different shape

| bound           | stops                         | default |
| --------------- | ----------------------------- | ------- |
| seen set        | cycles (A → B → A)            | —       |
| `maxIndexDepth` | an index chain a site extends | 3       |
| `maxSitemaps`   | a wide tree, counted overall  | 50      |

**The seen set is not redundant with the counters, and that matters.** A cycle
caught by a count bound still costs the entire budget — fifty fetches of two
documents. Caught by identity, A → B → A terminates having fetched two
documents with no bound firing at all, which is what the test asserts.

**`maxIndexDepth = 3`.** sitemaps.org describes one level of index and Google
documents support for one. Three leaves room for a generator that nests further
without following a chain a site can extend indefinitely.

**`maxSitemaps = 50`, counted across the whole tree.** ⚠️ Per-level would bound
nothing: an index of 50 indexes of 50 indexes is 2,500 fetches with no level
exceeding 50. The number is generous against what could possibly be used — the
frontier row ceiling is `clamp(pageLimit × 10, 500, 20000)`, so a single 50,000-
URL sitemap already exceeds any crawl's capacity to record — and bounded against
politeness, which is the real constraint: 50 requests to someone's server for
files we may not need.

**Breadth-first**, so the total bound truncates the deepest, least likely levels
rather than abandoning a whole branch that happened to be visited second.

## Decision 2 — the walk admits nothing

`walkSitemaps` produces `Candidate[]`. `enqueueFromSitemap` passes them to
`enqueueDiscovered` and adds **no checks of its own** — same `decideEnqueue`,
same scope check, same robots consultation, same budget, same row ceiling as a
URL found in an anchor tag.

A second admission path is how two paths drift and one ends up more permissive.
The integration suite proves the shared one by choosing cases a parallel
implementation would plausibly get wrong: an out-of-scope URL the sitemap
claims, a path the site's own robots.txt forbids, and a site disallowed because
robots could not be read. Each asserts the `skip_reason` the shared decision
writes.

⚠️ **The most interesting of those is a sitemap advertising a robots-disallowed
path.** The site is contradicting itself. robots wins, because it is the
permission artefact and the sitemap is a suggestion (ADR-0035, ADR-0051).

### Why the walk is a separate file from the enqueue

`walkSitemaps` takes only a network, so cycles and depth bounds are unit-tested
in microseconds. `enqueueFromSitemap` takes a transaction. `decide.ts` already
makes this argument for itself — "a pure function can be tested exhaustively in
microseconds; the same logic embedded in a transaction can only be tested
against the combinations someone thought to seed a database for" — and the
recursion bounds are exactly that kind of logic.

## Decision 3 — sitemap candidates are depth 0

Frontier `depth` is distance from the seed. A sitemap-listed page was not
reached by traversing anything: the site asserted it directly.

Depth 0 is therefore the honest value, and it has a consequence worth stating:
`budget.maxDepth` never refuses a sitemap URL. That is correct — refusing a page
for a traversal that never happened would be inventing a click distance to
punish it with — but it means a sitemap can introduce pages that a link crawl
bounded by `maxDepth` would not have reached. `pageLimit` and the row ceiling
still bound the total.

## ⚠️ A correction: `discoveredFrom` is a UUID, not a URL

`enqueueDiscovered`'s sixth parameter is typed `string | null` and named
`discoveredFrom`. The first version of `enqueueFromSitemap` passed the starting
sitemap URL. The database rejected the insert: it is a **`uuid` self-reference
to another `crawl_frontier` row** (`crawl.ts:277`).

The signature was read; the schema was not. A `string` parameter is a UUID as
readily as a URL, and the name did not disambiguate.

It is now `null`, which is the honest value rather than a workaround — a sitemap
document is not a frontier row, so there is nothing for a sitemap-discovered URL
to point at.

⚠️ **The cost:** for a `sitemapindex` tree the frontier records _that_ a URL came
from a sitemap, not _which_ sitemap listed it. Recording that needs a column the
schema does not have, and adding one is a migration outside this brief.

## Alternatives considered

**Recurse depth-first with a visited set and no count bound.** Rejected: depth
alone does not bound width, and one index listing 50,000 children is a legal
sitemap.

**Bound child sitemaps per index rather than per tree.** Rejected by
construction above — it bounds nothing.

**Let the walk call `decideEnqueue` itself and return decisions.** Tempting, and
it would satisfy "returns what was admitted" more literally. Rejected: it would
put admission in two places, and the frontier's version is the one that also
writes the rows, counts the budget and deduplicates against the database.

**Return per-URL refusal reasons from `enqueueFromSitemap`.** Rejected as a
second copy of a fact the database already holds: `enqueueDiscovered` writes a
`skip_reason` on every refused row, so "why was this one not crawled" is
answerable per URL from the frontier itself.

## Consequences

### Positive

- A cycle, a deep chain and a wide tree each terminate, and each test asserts
  which bound fired and the count or depth reached.
- One admission path. A sitemap cannot smuggle a URL past scope or robots.
- No schema change and no new enum value — the precedent already existed.

### Negative

- **`maxSitemaps = 50` is a judgement, not a measurement.** It is argued against
  the row ceiling and against politeness, but no real corpus of sitemap trees
  was measured, and I would not defend 50 over 30 or 100 on evidence.
- **Which sitemap listed a URL is not recorded**, per the correction above.
- **Depth 0 means `maxDepth` never bounds sitemap discovery.** Deliberate, and
  it makes a sitemap a way to introduce pages a depth-limited link crawl would
  not reach.
- **A sitemap walk is 50 requests before a single page is fetched**, worst case,
  against a server we are about to crawl anyway.

## Verification

**14 unit tests** for the walk, **7 integration tests** for the enqueue.

⚠️ **Each bound was proven load-bearing by removing it.** Deleting the seen set
fails exactly the two cycle tests; deleting `maxSitemaps` fails exactly the two
width tests; deleting `maxIndexDepth` fails exactly the two depth tests. Nothing
else moves in any of the three, so each test targets its own bound rather than
passing on a neighbour's.

⚠️ **The first attempt at those controls did not run at all.** They were wrapped
in `timeout`, which does not exist on macOS, so the command failed and the file
was restored before anything executed — three green controls that never ran.
Caught by the absence of output, not by the output.

`verify:all` exit 0 at **1,220 passed / 237 skipped (1,457)**, against 1,206 /
230 (1,436) at `db078d3`. Against a throwaway database migrated from zero, the
whole suite is **1,457 passed, 0 skipped**.
