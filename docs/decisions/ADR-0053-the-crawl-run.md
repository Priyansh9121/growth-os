# ADR-0053 — One crawl run: robots, then sitemap, then pages

**Status:** Accepted
**Date:** 2026-08-19

## Context

Three subsystems existed and were each fully tested in isolation — robots
fetching, sitemap discovery into the frontier, and the frontier's
claim/complete cycle. Nothing decided the order they run in, and nothing took a
claimed frontier URL and fetched it.

## ⚠️ Re-measured first

The brief asked whether a page-fetch path already existed. **It did not.** The
only `safeFetch` callers were `robots/fetch.ts`, `sitemap/fetch.ts` and
`sites/verification.ts`. This is the crawler's first page fetch.

The _recording_ side did already exist and was not rebuilt: `crawl_pages` with
its response columns, `PAGE_FETCH_OUTCOMES`, `markFetched`, `markFailed`,
`claimNext`, `frontierCounts`, `finishCrawl` — and `crawlProgress`, which the
brief asked to check for and which already wraps `terminationReason` and reads
cancellation from the database.

## Decision 1 — the run order, and why it is barely a decision

**robots → sitemap → pages.** ADR-0035 already decided that an unreadable
`robots.txt` disallows the entire site, so its outcome gates everything after
it. ADR-0051 already decided a missing sitemap is normal and stops nothing.
Composing them in any other order would contradict one of those.

The only genuinely new part is what a `siteDisallowed` run does: it walks
**nothing** and fetches **nothing**, and still finishes cleanly with a
termination reason rather than erroring. The frontier already enforces this —
`decideEnqueue` refuses every candidate with `robots_disallowed` — so the
orchestrator does not re-check it. It simply does not look for a sitemap it has
no permission to act on, which is what `SITEMAP_OUTCOMES`' `skipped` value
means: _"Not looked for, because robots.txt was unreadable."_

## Decision 2 — a page fetch produces facts and nothing else

`fetchPage` returns a status, a media type, a duration, a byte count, redirect
facts and conditional-request headers. It does **not** parse the body.

⚠️ **The consequence, stated plainly: a crawl driven by this discovers pages
only from the seed and from sitemaps.** HTML link extraction is a separate
brief, so a site with no sitemap yields exactly one page. That is a known
limitation of this session's output, not a defect it left behind.

### `blocked` versus `failed` splits on WHO DECIDED, not how bad it was

`blocked` means a policy of ours refused it — the SSRF classifier, the URL
policy, a content type, a body over the cap. `failed` means we tried and the
network did not cooperate.

An operator reading _blocked_ should look at their site's configuration; reading
_failed_ they should look at their server. Splitting on severity instead would
merge those.

### ⚠️ The SSRF pipeline runs at fetch time even though the URL passed admission

A frontier row was admitted once, possibly minutes earlier. Admission and
fetch-time defence are **different hops**: DNS can resolve to a public address
when a URL is queued and a private one when it is fetched, which is precisely
the rebinding window `safeFetch` pins against. Reusing the admission decision to
skip the fetch-time hop is the fast path §5 forbids, and it is tempting exactly
because the URL "already passed".

Proven with `ForbiddenTransport`, which throws if dialled: the assertion is that
no socket was opened, not that an error came back.

## ⚠️ Decision 3 — the sitemap outcome must be mapped, because the enums disagree

Measured, and it contradicts the shape the code arrived in:

| `SitemapFetchOutcome` (fetch layer) | `SITEMAP_OUTCOMES` (database) |
| ----------------------------------- | ----------------------------- |
| `fetched`                           | `fetched`                     |
| `absent`                            | `absent`                      |
| `error`                             | `error`                       |
| `unavailable`                       | —                             |
| `not_a_sitemap`                     | —                             |
| —                                   | `truncated`                   |
| —                                   | `skipped`                     |

`RobotsFetchOutcome` matches `ROBOTS_OUTCOMES` exactly; the sitemap pair does
not. The database enum is not wrong — `truncated` and `skipped` are facts only
the **orchestrator** knows (was the walk cut short; was a sitemap looked for at
all), and `unavailable`/`not_a_sitemap` are facts only the **fetch layer**
knows. They are two different vocabularies for two different vantage points, and
the mapping is where they meet:

- robots unreadable → never looked → `skipped`
- fetched, and a walk bound fired → `truncated`
- fetched → `fetched`
- absent → `absent`
- `unavailable` | `error` | `not_a_sitemap` → `error`

⚠️ `not_a_sitemap` maps to `error`, **not** `absent`. ADR-0051 separated them
deliberately, because reporting a 200-with-an-HTML-404-page as "absent" is a
small lie an operator cannot debug. Mapping it back to `absent` would
re-introduce exactly that.

## ⚠️ A documented control that does not exist

`contracts/src/crawl/enums.ts` says of `CRAWL_FAILURE_CATEGORIES` and
`@growth-os/net`'s failure unions: _"the two lists are kept in agreement by a
test rather than by an import."_

**No such test is in the repository.** Measured this session: all 23 net failure
literals do appear in `CRAWL_FAILURE_CATEGORIES`, and the crawler adds four of
its own — so they agree _today_. That is a point-in-time measurement, not the
standing guarantee the comment claims.

`fetchPage` therefore narrows defensively rather than casting: an unrecognised
failure becomes `null` and the row still records its outcome, instead of an
insert failing on an enum value the database has never heard of.

Fixing the missing test is out of this brief's scope and reported in dev log 0034. This is the same class as dev log 0018's `neutraliseCsvFormula` finding —
a control documented as live with nothing implementing it.

## Alternatives considered

**Extract links from fetched pages, so a crawl walks a site.** Out of scope by
the brief, and correctly: HTML extraction over hostile input is its own brief
with its own hostile-input corpus, and bolting a quick version onto this
orchestrator is how the robots parser got written twice.

**Re-check robots when a page is claimed rather than at enqueue.** Rejected —
`decide.ts` already argues it: a disallowed URL must never become work, and
checking after dequeue would let the frontier count budget against URLs that
were never going to be fetched.

**Let the orchestrator re-check scope or robots before fetching.** Rejected as a
second admission path, the same reasoning ADR-0052 used for sitemaps.

**Fetch pages concurrently.** Out of scope. `claimNext` already uses
`FOR UPDATE SKIP LOCKED` so a worker pool composes without changing this
function, which is why one-at-a-time is a starting point rather than a design
that has to be undone.

## Consequences

### Positive

- One function runs a crawl, composing three tested subsystems and adding no
  admission logic of its own.
- The fail-closed rule holds end to end: an unreadable `robots.txt` yields zero
  fetches even when a sitemap and frontier candidates exist.
- Page fetches re-enter the full SSRF pipeline, proven by a transport that
  throws if dialled.

### Negative

- **Seed and sitemap are the only discovery sources.** A site with no sitemap
  yields a one-page crawl. Stated in the dev log as a limitation of this
  session's output.
- **One page at a time.** Correct for a first version and slow for a real crawl.
- **The sitemap outcome mapping is lossy.** `unavailable`, `error` and
  `not_a_sitemap` all become `error` in the crawl row, so an operator sees "we
  could not read your sitemap" without which of the three it was. The
  distinction survives in the walk result the caller receives, not in the column.
- **`fetchPage`'s defensive enum narrowing hides a divergence rather than
  failing on it.** If the lists ever drift, a failure category silently becomes
  null instead of the insert erroring. That is the right trade for a crawl
  worker and it is still a swallowed signal.

## Verification

**20 unit tests** for `fetchPage`, including the SSRF refusal proven with
`ForbiddenTransport`, the `blocked`/`failed` split, every status class, and a
test asserting the observation's exact key set so link extraction or a severity
cannot be added without changing it.

Integration coverage for the run order is recorded in the slice that adds it.
