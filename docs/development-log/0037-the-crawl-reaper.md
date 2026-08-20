# 0037 — The crawl reaper, and the precedent the brief told me to copy was a no-op

**Date:** 2026-08-20 · **Stage:** 4

## Objective

Reap crawls stranded in `running` by a worker that died with the database — the
gap [0036](0036-the-crawler-gets-a-caller.md) found, left open deliberately, and
ranked first in its remaining work.

## Initial state

Verified, not recalled: `7f9cb58`, tree clean, `verify:all` exit 0 at **1250
passed / 275 skipped (1525)**, 29 boundary probes, remote PRIVATE, `0 0`
ahead/behind. Matched the brief.

### ⚠️ The database was gone

Not a repository problem, but it blocked §7.2 and every integration test.
[0001](0001-project-foundation.md) records that this project runs an **isolated
cluster in scratch space on port 55432**, because the machine's own PostgreSQL
on 5432 is password-protected and untouched. That scratch directory had been
cleared — no data directory, no listener.

Recreated with the same EDB PostgreSQL 18 binaries at
`~/.growth-os/pgdata`, **persistent this time rather than in `/tmp`**, port
55432, `growth_os` and `growth_os_test` migrated to 11. Full suite against it
before touching anything: **1525 passed (1525)**.

## ⚠️ The finding: the brief's stated precedent updates nothing, forever

The brief said `reclaimStalledJobs` is _"the precedent to copy, not reinvent"_.
It is not, and the reason is one table's row-level security.

Measured against the restricted role production connects as:

| Probe                                                      | Rows |
| ---------------------------------------------------------- | ---- |
| Unscoped `SELECT` on `crawls`                              | 0    |
| Unscoped `UPDATE` — exactly the `reclaimStalledJobs` shape | 0    |
| The same inside `withUnscopedTransaction`                  | 0    |
| `SELECT` on `workspaces`                                   | 1    |

**`jobs` has no RLS. `crawls` and `crawl_frontier` are `ENABLE` and `FORCE`.**
The precedent works because its table is untenanted. Copied, it produces a
reaper that updates nothing while looking exactly like a system with no stale
crawls — and `withUnscopedTransaction` does not rescue it, because "unscoped" is
not "exempt": it leaves `app_current_workspace_id()` null, so the tenant policy
matches nothing.

This is the §6 failure mode precisely. A test asserting _"the reaper ran"_ would
pass. **Both negative results are now pinned as tests** rather than described in
a comment — if either ever returns rows, RLS was disabled or the application is
connecting as an exempt role, and this design's premise has changed.

The sweep therefore enumerates `workspaces` and opens one tenant transaction
each. Cost is O(workspaces) per pass, stated in the docblock and in ADR-0055
along with the `SECURITY DEFINER` upgrade path, rather than left to be
discovered.

A role with `BYPASSRLS` was rejected without qualification.
`infrastructure/create-app-role.sql` spells `NOBYPASSRLS` out because it _is_
the security property.

## The threshold is derived, and a constant cannot be right

`STALLED_MS` is ten minutes, correct for a retention job that runs in
milliseconds. A crawl legitimately runs for hours.

```
stale after = started_at + page_limit × 30s + 30min
```

Every term measured this session, not recalled:

- **30 s** — `DEFAULT_TIMEOUTS.totalMs` in `@growth-os/net`, a wall-clock
  ceiling on one exchange. Verified `pages/fetch.ts` does not override it.
- **`page_limit`** — the crawl's own budget, `CHECK`-bounded to 1..10,000.
- **one page at a time** (0036), so `page_limit × 30s` bounds the page phase.
- **30 min** — robots plus the sitemap walk, bounded by `maxSitemaps = 50`;
  51 × 30 s ≈ 25.5 min, rounded up.

A 10-page crawl is stale after ~35 minutes; a maxed-out one after ~83 hours. A
test proves the scaling directly: two crawls of the same age and different
budgets, only the small one reaped.

**The direction of the error is the point.** Reaping late costs an operator some
confusion. Reaping early destroys a working crawl's record and writes a failure
that never happened.

## The frontier, and a third rejection of a near-miss label

`finishCrawl` marks leftover `queued` rows `skipped`/`cancelled`. The reaper
marks `queued` **and** `fetching`, with a new reason `abandoned` (migration
0011).

`cancelled` asserts an operator decided to stop. Nobody decided anything — a
process died. That is the same class of typed lie as ADR-0042's two splits
(`url_too_long` out of `unsupported_scheme`, `budget_exhausted` out of
`robots_disallowed`) and migration 0010's `internal_error` one session ago. The
project has now declined to borrow a near-miss label three times, which makes it
a rule rather than a preference.

`fetching` is included because `finishCrawl` never has to consider it — it runs
after the loop stops claiming. A crawl killed mid-flight is exactly when a row is
left claimed, and a row that says it is in flight with nothing flying it is this
bug's frontier version. Already-`fetched` rows are untouched: that work really
happened.

## The constraints, re-read rather than recalled

0036's whole finding was a `CHECK` contradicting an assumption that looked right
on paper, so §1 required re-reading these:

| Constraint                                | Requires                                     |
| ----------------------------------------- | -------------------------------------------- |
| `crawls_failed_has_category`              | `failed` ⇒ `failure_category` not null       |
| `crawls_terminal_status_has_completed_at` | `failed` ⇒ `completed_at` not null           |
| `crawls_running_has_started_at`           | a non-`queued` crawl always has `started_at` |

The third is load-bearing in a way worth naming: it is what makes `started_at`
safe to key the sweep on, because the database guarantees it is never null for
the rows being examined.

## What was built

| Slice     | Change                                                          |
| --------- | --------------------------------------------------------------- |
| `23f2a39` | `abandoned` skip reason, migration 0011, ADR-0055               |
| `63d3fd9` | `reapAbandonedCrawls` + `crawlStaleAfter`, 22 integration tests |
| `f216d06` | Wired into `runOnce`; 0036's gap asserted closed                |

## Testing

- `verify:all` exit 0: **1250 passed / 299 skipped (1549)**, against 1250 / 275
  (1525) at `7f9cb58`. 29 boundary probes.
- §7.2: 12 migrations applied from zero on a throwaway database, full suite
  **1549 passed (1549)** exit 0, database destroyed.
- **All 24 new tests need a database; none runs in the default gate**, which is
  why `verify:all`'s passing count did not move at all.

The gap is closed by running **the exact scenario that opened it**: 0036's
"database stays down" test now continues past its original assertion — the crawl
is confirmed stranded, the reaper runs, and it ends `failed`. Testing the
mechanism in isolation and inferring the rest would not have been the same claim.

## Result

A crawl abandoned by a dead worker becomes `failed` within a bound derived from
its own budget, its frontier says honestly what happened, and the reaper runs
every worker pass.

## ⚠️ What is NOT proven

**The wiring in `runOnce` has no test.** `runOnce` closes over a module-level
`getDatabase()` bound to `DATABASE_URL`, so driving it from a test would operate
on the **dev** database rather than the test one. That is pre-existing and
structural — verified by grep this session that no test imports `./main`, which
is why `worker.integration.test.ts` tests `./queue` directly.

So: the reaper's behaviour is proven by 22 tests against the restricted role.
That it is **called each pass** is verified by reading `main.ts` and by
typecheck, and by nothing else. Closing that needs the database injected into
`runOnce`, a refactor this brief did not name.

## Remaining work

1. **Inject the database into `runOnce`** so the worker's own pass is testable
   at all. It would have caught this session's wiring, and would let the three
   retention jobs be tested through the pass rather than around it.
2. **No UI.** A crawl's status is reachable only by API.
3. **Cancellation.** `cancel_requested_at` exists and `crawlProgress` reads it;
   nothing sets it.
4. **HTML link extraction**, still the largest limit on the crawler: a site with
   no sitemap yields a one-page crawl.
5. **One page at a time.** `claimNext` already uses `FOR UPDATE SKIP LOCKED`, so
   a pool composes without changing `runCrawl` — and would invalidate this
   session's threshold derivation, which assumes serial fetching. Named here so
   whoever parallelises the crawl knows to revisit `crawlStaleAfter`.

⚠️ **A carried item that is now materially wrong, and this session is why.**
Every dev log since [0023](0023-one-migration-three-findings.md) has recorded
"the local dev database sits at migration 0007, 8 of 10". That is no longer
true: the cluster was destroyed by the environment and **rebuilt from zero this
session**, so `growth_os` is at **11 of 12** and `growth_os_test` at **12 of
12** — measured, not inferred from having run the migrator.

The one outstanding migration on the dev database is this session's own 0011,
applied to the test database but not the dev one. Whoever carries this item next
should carry the new number, not the sentence six logs have copied.

⚠️ **Environment, for the next session:** the database now lives at
`~/.growth-os/pgdata` and must be started before any integration test:
`pg_ctl -D ~/.growth-os/pgdata -o "-p 55432 -k /tmp" start`. The previous
location was cleared between sessions, which is what prompted moving it.
