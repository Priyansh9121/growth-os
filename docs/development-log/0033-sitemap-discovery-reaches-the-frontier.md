# 0033 — Sitemap discovery reaches the frontier, and two things I read wrong

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Wire sitemap discovery into the frontier: admit sitemap-listed URLs through the
existing admission pipeline, and follow a `sitemapindex` with explicit, tested
bounds.

## Initial state

Verified, not recalled: `db078d3`, tree clean, `verify:all` exit 0 at **1206
passed / 230 skipped (1436)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Re-measured first, as the brief insisted — and the precedent already existed

The brief asked whether the frontier could already distinguish a
sitemap-discovered URL, or whether a field needed inventing. **Nothing needed
inventing:**

- `DiscoverySource` (`decide.ts:37`) already reads
  `'seed' | 'link' | 'sitemap' | 'redirect'`.
- `Candidate` is `{ url, base?, depth, source }` — already exactly what a walk
  produces.
- `crawl_frontier.discovery_source` already stores it.

A negative result, and the useful kind: the whole schema question evaporated.

**Also verified rather than assumed:** `normaliseUrl` is idempotent across a
12-case corpus. That matters because `parseSitemap` already normalised every
`<loc>` and `enqueueDiscovered` normalises again — which is the same function
called twice, not a second definition (§5), but only if it is idempotent.

## ⚠️ Two things I read wrong

### 1. `discoveredFrom` is a UUID, not a URL

`enqueueDiscovered`'s sixth parameter is `discoveredFrom: string | null`. I
passed the starting sitemap URL. The database rejected the insert: it is a
**`uuid` self-reference to another `crawl_frontier` row** (`crawl.ts:277`).

I read the TypeScript signature and inferred the meaning. `string` is a UUID as
readily as a URL, and the parameter name did not disambiguate. **The brief told
me to re-read the frontier module before assuming anything about its shape; I
read the signature and not the schema.**

It is now `null` — the honest value, because a sitemap document is not a
frontier row, so there is nothing to point at. Cost, stated: for an index tree
the frontier records _that_ a URL came from a sitemap, not _which_ one.

### 2. Three negative controls that never ran

To prove each recursion bound was load-bearing I removed it and re-ran. All
three reported no failures. They also reported nothing else — because I wrapped
them in `timeout`, which **does not exist on macOS**, so the command failed
immediately and the `cp` restored the file before anything executed.

Caught by the _absence_ of output, not by the output. Re-run properly, each
bound is load-bearing:

| removed         | fails                     |
| --------------- | ------------------------- |
| seen set        | exactly the 2 cycle tests |
| `maxSitemaps`   | exactly the 2 width tests |
| `maxIndexDepth` | exactly the 2 depth tests |

Nothing else moves in any of the three, so each test targets its own bound
rather than passing on a neighbour's.

⚠️ Worth naming because it is the second session running where a _verification
step itself_ was the thing that was broken. 0032 had a test whose fixture did
not reproduce the condition it named. This had a control that did not execute.
A green control proves nothing until you have checked it ran.

## The bounds

| bound           | stops                         | default |
| --------------- | ----------------------------- | ------- |
| seen set        | cycles (A → B → A)            | —       |
| `maxIndexDepth` | an index chain a site extends | 3       |
| `maxSitemaps`   | a wide tree, counted overall  | 50      |

The seen set is not redundant with the counters: a cycle caught by a _count_
bound still costs the whole budget — fifty fetches of two documents. Caught by
identity, A → B → A terminates having fetched two documents with **no bound
firing at all**, which is what the test asserts.

`maxSitemaps` counts across the whole tree. Per-level would bound nothing: an
index of 50 indexes of 50 indexes is 2,500 fetches with no level exceeding 50.

## No second admission path

`walkSitemaps` produces candidates; `enqueueFromSitemap` hands them to
`enqueueDiscovered` and adds nothing. The integration suite proves the shared
path by choosing cases a parallel implementation would plausibly get wrong:

- an out-of-scope URL the sitemap claims → `external`
- a path the site's own robots.txt forbids → `robots_disallowed`
- a site disallowed because robots could not be read → nothing queued
- the page budget → 3 queued, 7 `page_limit`

⚠️ The sharpest is a **sitemap advertising a robots-disallowed path** — the site
contradicting itself. robots wins, because it is the permission artefact and the
sitemap is a suggestion.

## Files

```
packages/crawler/src/sitemap/walk.ts                      walkSitemaps, bounds
packages/crawler/src/sitemap/walk.test.ts                 14 tests
packages/crawler/src/sitemap/enqueue.ts                   enqueueFromSitemap
packages/crawler/src/sitemap/enqueue.integration.test.ts  7 tests
packages/crawler/src/index.ts                             exports
docs/decisions/ADR-0052-sitemap-walk-bounds.md
docs/development-log/0033-sitemap-discovery-reaches-the-frontier.md
docs/decisions/README.md, docs/development-log/README.md  index rows
```

## Testing

**21 new tests** — 14 unit, 7 integration. Both files written and observed red
before their implementations existed (§2).

`verify:all` exit 0: **1,220 passed / 237 skipped (1,457)**, against 1,206 / 230
(1,436) at the start. 29 boundary probes.

§7.2: a throwaway database was created, migrations applied **from zero**, the
whole suite run against it at **1,457 passed / 0 skipped**, and the database
dropped. The integration tests are the §5 proof, so shipping them skipped would
have proved nothing.

⚠️ One measurement error caught while reporting: a `verify:all` run that inherited
`TEST_DATABASE_URL` from the same shell reported 1,457 / 0 skipped and looked
like the clean gate number. It was not. Re-run with `env -u`, the honest no-database
figure is 1,220 / 237.

## Result

A sitemap now becomes crawl work, through the same admission every other
discovered URL uses. Cycles, deep chains and wide trees each terminate at a
named bound, and each bound is proven load-bearing by removing it.

**The session's real content was the re-measurement.** The schema question the
brief raised had already been answered by a previous session, and the two things
that went wrong were both places where I read a name and inferred a meaning —
a parameter's type, and a shell command's availability. Neither was in the code
I wrote.

## Remaining work

The next brief is the crawl service: when a sitemap walk happens relative to
robots.txt fetching and page crawling, and how a crawl run composes them. This
session produced the function and deliberately stopped.

⚠️ Not defects, but known and unaddressed:

- **`maxSitemaps = 50` is a judgement, not a measurement.** Argued against the
  row ceiling and against politeness; no real corpus of sitemap trees was
  measured, and I would not defend 50 over 30 or 100 on evidence.
- **Which sitemap listed a URL is not recorded** — needs a column the schema
  does not have.
- **Depth 0 means `maxDepth` never bounds sitemap discovery.** Deliberate: a
  listed page was not reached by traversal, so there is no click distance to
  punish it with. It does mean a sitemap can introduce pages a depth-limited
  link crawl would not reach; `pageLimit` and the row ceiling still bound the
  total.

Carried, unchanged: the local dev database at migration 0007, the permanently
deferred client-side email regex, and 0030's open question about whether the 4×
expansion ratio should be a constraint rather than a convention.
