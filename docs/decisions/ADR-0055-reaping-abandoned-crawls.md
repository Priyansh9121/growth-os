# ADR-0055 — Reaping abandoned crawls: per-tenant, budget-derived, honestly labelled

**Status:** Accepted
**Date:** 2026-08-20

## Context

[ADR-0054](ADR-0054-starting-a-crawl.md) wired the crawler to a worker. Dev log
0036 then measured a gap and left it open deliberately: if the database
connection dies at the moment a crawl job is recording its own failure, the
crawl row stays `running` with a `started_at` that never advances. To an
operator that is indistinguishable from a crawl that is merely slow —
permanently. A test in `run-crawl.integration.test.ts` asserted that as the
current behaviour rather than papering over it.

`apps/worker/src/queue.ts` already reaps stalled **jobs**. There was no
counterpart for **crawls**.

## ⚠️ Re-measured first, and the obvious implementation is a silent no-op

The brief for this work said `reclaimStalledJobs` was "the precedent to copy,
not reinvent". Measured against the restricted role that production connects as:

| Probe                                                      | Rows affected |
| ---------------------------------------------------------- | ------------- |
| Unscoped `SELECT` on `crawls`                              | **0**         |
| Unscoped `UPDATE` — exactly the `reclaimStalledJobs` shape | **0**         |
| The same inside `withUnscopedTransaction`                  | **0**         |
| `SELECT` on `workspaces`                                   | 1             |

**`jobs` has no row-level security. `crawls` and `crawl_frontier` are `ENABLE`
and `FORCE`.** The precedent works because its table is untenanted, and copying
its shape produces a reaper that updates nothing, forever, while looking exactly
like a system with no stale crawls. `withUnscopedTransaction` does not help — it
leaves `app_current_workspace_id()` null, so the tenant policy matches nothing.

This is the failure mode §6 exists for: a test asserting "the reaper ran" would
pass.

## Decision 1 — sweep per workspace, in a tenant transaction

The reaper enumerates `workspaces` (untenanted, so readable) and opens one
`withTenantTransaction` per workspace, doing the update inside it. RLS is
respected rather than escaped, and the write goes through the same policy every
other crawl write does.

### Alternatives rejected

**A role with `BYPASSRLS`.** Rejected without qualification.
`infrastructure/create-app-role.sql` spells `NOBYPASSRLS` out explicitly because
it is the security property, and `docs/security/tenant-isolation.md` names
connecting as an exempt role as the way tenant isolation silently stops
existing. A background sweep is not worth that.

**A `SECURITY DEFINER` function** returning stale `(id, workspace_id)` pairs.
Genuinely better on cost — it would visit only workspaces that have a stale
crawl instead of all of them — and it is the upgrade path when workspace count
makes that matter. Rejected for now because it adds a privileged database
surface to solve a problem this system does not yet have, and the cost is stated
below rather than hidden.

⚠️ **The cost, stated:** this is O(workspaces) transactions per worker pass, not
O(stale crawls). At today's scale that is nothing. At ten thousand workspaces it
is untenable and the `SECURITY DEFINER` discovery query above is the fix.

## Decision 2 — the staleness threshold is derived from the crawl's own budget

Not a constant. A crawl is stale when

```
started_at < now() - (page_limit × 30s + 30min)
```

Every term is measured, not chosen:

- **30 s** is `DEFAULT_TIMEOUTS.totalMs` in `@growth-os/net` — a wall-clock
  ceiling on one exchange, "whatever else is happening". Verified that
  `pages/fetch.ts` does not override it.
- **`page_limit`** is the crawl's own recorded budget, bounded by
  `crawls_budget_is_bounded` to 1..10,000.
- Crawls fetch **one page at a time** (dev log 0036), so `page_limit × 30s` is a
  true upper bound on the page phase.
- **30 min** covers robots (one fetch) plus the sitemap walk, bounded by
  `maxSitemaps = 50` — 51 × 30 s ≈ 25.5 min, rounded up.

### ⚠️ Why a fixed constant would be wrong in both directions

`STALLED_MS` is 10 minutes, which is right for a retention job that runs in
milliseconds. A crawl legitimately runs for hours. A constant tight enough to
catch a dead small crawl promptly would reap a live large one; a constant loose
enough to be safe for a 10,000-page crawl would hide a dead 10-page crawl for
days. Deriving it gives both: a 10-page crawl is stale after ~35 minutes, a
maxed-out one after ~83 hours.

**The safety property is the direction that matters.** The threshold is a bound
on what a crawl could still legitimately be doing, so the reaper cannot mark a
working crawl failed. Reaping late costs an operator some confusion; reaping
early destroys a running crawl's record and writes a false failure.

## Decision 3 — frontier rows become `skipped` / `abandoned`, a new reason

`finishCrawl` marks leftover `queued` rows `skipped` with reason `cancelled`.
The reaper marks both `queued` **and** `fetching` rows, with a new reason
`abandoned` (migration 0011).

**`cancelled` is not reused, and that is the whole point.** It asserts that an
operator decided to stop. Nobody decided anything — a process died. This is the
same class of typed lie as the two splits ADR-0042 made (`url_too_long` out of
`unsupported_scheme`, `budget_exhausted` out of `robots_disallowed`) and as
migration 0010's `internal_error`, added one session ago for exactly this
reason. The project has now rejected borrowing a near-miss label three times.

`fetching` rows are included because `finishCrawl` never has to consider them —
it runs when the loop has stopped claiming — whereas a crawl killed mid-flight
is precisely when a row is left claimed. A row that claims to be in flight, with
nothing flying it, is the frontier's version of the bug this ADR exists to fix.

## Decision 4 — a reaped crawl is `failed`, and stays failed

`internal_error`, `completed_at` set, and a `failure_detail` an operator can
read. No automatic retry: whether a failed crawl can be re-run is a product
decision with its own consequences, and inventing an implicit one inside a
reaper is how a crawl loop becomes a crawl storm.

The CHECK constraints make this shape mandatory rather than optional, and were
re-read rather than recalled:

| Constraint                                | Requires                                  |
| ----------------------------------------- | ----------------------------------------- |
| `crawls_failed_has_category`              | `failed` ⇒ `failure_category` not null    |
| `crawls_terminal_status_has_completed_at` | `failed` ⇒ `completed_at` not null        |
| `crawls_running_has_started_at`           | a `running` crawl always has `started_at` |

The third is what makes `started_at` safe to key the sweep on: the database
guarantees it is never null for the rows being examined.

## Consequences

- The gap dev log 0036 named is closed, and its test now asserts the fix rather
  than the gap.
- A crawl abandoned by a dead worker becomes `failed` within a bound derived
  from its own budget, and its frontier says honestly what happened.
- The reaper is O(workspaces) per pass. Named above as the thing to change
  first when that stops being free.
