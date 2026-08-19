# 0034 — The crawl run, and a termination check that stops before it starts

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Compose robots fetching, sitemap discovery and the frontier into one crawl run,
and add the crawler's first page fetch.

## Initial state

Verified, not recalled: `65a76dd`, tree clean, `verify:all` exit 0 at **1220
passed / 237 skipped (1457)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Re-measured first

The brief asked whether a page-fetch path already existed. **It did not** — the
only `safeFetch` callers were `robots/fetch.ts`, `sitemap/fetch.ts` and site
verification.

The **recording** side did already exist and was not rebuilt: `crawl_pages` and
its response columns, `PAGE_FETCH_OUTCOMES`, `markFetched`, `markFailed`,
`claimNext`, `frontierCounts`, `finishCrawl` — and `crawlProgress`, which the
brief asked me to check for and which already wraps `terminationReason` and
reads cancellation from the database.

## ⚠️ The finding: `crawlProgress` cannot be the loop condition

The budget test failed with `expected 0 to be 2`. A crawl with `pageLimit: 2`
fetched **zero** pages.

`terminationReason` returns `budget_exhausted` when `fetchable >= pageLimit`,
and `frontierCounts` counts a row as `fetchable` while it is still **`queued`**.
`decideEnqueue` admits at most `pageLimit` fetchable rows — so that condition is
true the instant admission fills the budget, before anything is fetched.

Its docstring reads _"Should the loop continue, and if not, why did it stop?"_
Both halves are in there, and only the second is usable: it is a **reason
reporter**, not a loop condition.

Neither function was changed. §3 says do the task in the brief, and the brief
says use `terminationReason` rather than redefine it — the reading was wrong,
not the code. The loop now ends when there is nothing left to claim and asks
`crawlProgress` afterwards _why_, with cancellation checked before each claim
because an operator expects Cancel to take effect promptly rather than after one
more page.

⚠️ This was only findable by composing the three subsystems. Each is fully
tested in isolation and every one of those tests still passes.

## The other measured findings

**The sitemap enums disagree, and neither is wrong.** `RobotsFetchOutcome`
matches `ROBOTS_OUTCOMES` exactly. `SitemapFetchOutcome` does not match
`SITEMAP_OUTCOMES`: the fetch layer produces `unavailable` and `not_a_sitemap`,
the column has `truncated` and `skipped`. Those are two vantage points —
`truncated`/`skipped` are facts only the orchestrator knows — so the run maps
between them. `not_a_sitemap` maps to `error`, **not** `absent`, because
ADR-0051 separated them precisely so a 200-with-an-HTML-404-page is not reported
as "no sitemap".

**⚠️ A documented control that does not exist.**
`contracts/src/crawl/enums.ts` says of `CRAWL_FAILURE_CATEGORIES` and
`@growth-os/net`'s failure unions that _"the two lists are kept in agreement by
a test rather than by an import."_ **No such test is in the repository.**
Measured: all 23 net failure literals do appear, and the crawler adds four of
its own — so they agree _today_, which is a point-in-time measurement rather
than the standing guarantee the comment claims. `fetchPage` narrows defensively
because of it. Reported, not fixed: same class as 0018's `neutraliseCsvFormula`.

## What was built

**`fetchPage`** — the first page fetch. Facts only: status, media type,
duration, bytes, redirect facts, conditional-request headers. A test asserts the
observation's exact key set, so links, a title or a severity cannot appear
without changing it.

`blocked` vs `failed` splits on **who decided** — a policy of ours, or the
network. An operator reading _blocked_ should check their configuration;
_failed_, their server.

⚠️ **The SSRF pipeline runs at fetch time even though the URL passed admission.**
Different hops: DNS can resolve to a public address when a URL is queued and a
private one when it is fetched. Proven with `ForbiddenTransport`, which throws
if dialled — the assertion is that no socket opened, not that an error returned.

**`runCrawl`** — robots → sitemap → pages, adding no rules of its own. A
transaction per step, never one across the run: a crawl is minutes of network
I/O and holding one would pin a connection and hold locks while waiting on
someone else's server.

## Files

```
packages/crawler/src/pages/fetch.ts                  fetchPage
packages/crawler/src/pages/fetch.test.ts             20 tests
packages/crawler/src/run/crawl.ts                    runCrawl
packages/crawler/src/run/crawl.integration.test.ts   8 tests
packages/crawler/src/index.ts                        exports
docs/decisions/ADR-0053-the-crawl-run.md
docs/development-log/0034-the-crawl-run.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Testing

**28 new tests** — 20 unit, 8 integration. Both files written and observed red
before their implementations existed (§2).

`verify:all` exit 0: **1,240 passed / 245 skipped (1,485)**, against 1,220 / 237
(1,457) at the start. 29 boundary probes.

§7.2: throwaway database created, migrations applied **from zero**, whole suite
run against it at **1,485 passed / 0 skipped**, database dropped. Not optional
this session — the run order is only observable against a real database.

The three required proofs, each asserted directly:

- **full run**: robots fetched, sitemap walked, 3 pages fetched, `site_pages`
  and `crawl_pages` written, crawl `completed` with its outcome columns.
- **fail-closed**: a 500 on `robots.txt` fetches **zero** pages though the
  sitemap and its URLs are all reachable, the sitemap is `skipped` (never looked
  for), and the seed is recorded `skipped`/`robots_disallowed` rather than
  silently absent.
- **missing sitemap**: a 404 sitemap still fetches the seed and finishes
  `frontier_empty`.

## Result

A crawl runs end to end. The composition surfaced a defect in how
`crawlProgress` reads that three separately-correct subsystems could not have
shown on their own.

## Remaining work

⚠️ **The largest limitation, stated plainly: no link extraction.** A page fetch
records facts about the response and nothing about the document, so the seed and
sitemaps are the only sources of frontier candidates. **A site with no sitemap
yields a one-page crawl.** That is this session's scope, not a defect it left —
but it is the single thing that most limits the crawler's usefulness right now,
and HTML extraction is the obvious next brief.

Also known and unaddressed:

- **One page at a time.** `claimNext` already uses `FOR UPDATE SKIP LOCKED`, so a
  worker pool composes without changing `runCrawl`.
- **The sitemap outcome mapping is lossy** — `unavailable`, `error` and
  `not_a_sitemap` all become `error` in the column.
- **`fetchPage`'s defensive enum narrowing hides a divergence rather than
  failing on it.** Right for a crawl worker, still a swallowed signal.
- **The missing enum-agreement test**, above. Its own brief.
- **`runCrawl` does not set `startedAt` or move `queued → running`** — it
  assumes the caller did, which the crawl-service brief will own.

Carried, unchanged: the local dev database at migration 0007, the permanently
deferred client-side email regex, and 0030's open question about the 4×
expansion ratio.
