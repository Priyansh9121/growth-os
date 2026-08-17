# ADR-0036 — `page_limit` counts pages fetched, and the frontier needs its own ceiling

**Status:** Accepted
**Date:** 2026-08-17

## Context

An operator configures a crawl with a page limit — 500 by default,
CHECK-constrained to 1–10,000 ([ADR-0034](ADR-0034-crawl-storage-model.md)). The
frontier discovers far more URLs than it fetches: every page links to
`/contact`, to external sites, to subdomains, and to paths `robots.txt`
disallows. All of those are **recorded**, because _"we found 900 URLs and
fetched 500"_ is a different fact from _"the site has 500 pages"_, and a crawler
that dropped the difference would report the second while meaning the first.

So `page_limit` has two defensible readings, and they are not close:

1. It caps **rows entering the frontier**. 500 discovered URLs, skipped ones
   included, exhausts it.
2. It caps **pages actually fetched**. Skipped and out-of-scope rows are recorded
   without consuming budget.

## Decision 1 — `page_limit` counts pages FETCHED

Reading (2).

**The limit is an operator-facing promise about work done against someone
else's server, and skipping a URL costs that server nothing.** A refusal is a
decision made locally; no packet leaves the machine.

Under reading (1) a site with 400 external links would get a fifth of the crawl
it configured — and the shortfall would depend entirely on how that particular
site links out. Two sites configured identically at 500 pages would receive 500
and 90. **That makes the number useless as a budget**: it stops being something
an operator can reason about and becomes an artefact of a stranger's markup.

Reading (2) makes `page_limit = 500` mean "we will fetch up to 500 pages", which
is both what it says and the only version an operator can act on.

Implementation: the budget is checked against a `fetchable` count — frontier rows
in state `queued`, `fetching` or `fetched`. Every URL that will consume a
request, and nothing else.

### ⚠️ Decision 1 leaves the frontier table unbounded

This is the consequence that makes someone argue for reading (1) later, so it is
recorded here rather than discovered.

If `page_limit` does not bound discovery, nothing does. One page linking to ten
thousand distinct filtered URLs — `?colour=red&size=10&sort=price`, a calendar,
a faceted catalogue — writes ten thousand skipped rows while fetching none. A
crawl configured for 50 pages can exhaust storage, and reading (1) would have
prevented it by accident.

Reading (1) is still the wrong fix, because it solves a storage problem by
breaking the operator's budget. The right fix is a second limit.

## Decision 2 — a separate, higher ceiling on frontier rows

```
frontierRowCeiling(pageLimit) = clamp(pageLimit × 10, 500, 20000)
```

| `page_limit`  | Frontier rows |
| ------------- | ------------- |
| 1–50          | 500 (floor)   |
| 100           | 1,000         |
| 500 (default) | 5,000         |
| 1,000         | 10,000        |
| 2,000–10,000  | 20,000 (cap)  |

**Why a multiple rather than a flat number.** It scales with what the operator
asked for. A 50-page microsite crawl and a 10,000-page retailer crawl are not the
same amount of legitimate discovery, and one number for both is either uselessly
loose for the small case or wrong for the large one.

**Why ten.** A real business site discovers roughly two distinct URLs per page
fetched, once navigation is deduplicated — internal pages plus external links
that repeat heavily across the site. Ten leaves a five-fold margin over
observed-shape traffic, which covers pagination and faceted navigation without
covering a generator.

⚠️ That "roughly two" is reasoning from the shape of the graph, **not a
measurement**. Nothing in this repository has crawled a real website yet. The
number should be revisited against the first real crawls, and this ADR is where
the revision goes.

**Why a floor of 500.** At `page_limit = 10` the multiple gives 100, and a single
link-heavy page can legitimately exceed that. Without a floor, small crawls would
truncate discovery immediately.

**Why a cap of 20,000.** Storage, multiplied by history. A frontier row is a URL
plus small columns — a few hundred bytes — so 20,000 rows is single-digit
megabytes per crawl. Crawl history is retained deliberately and **has no decided
retention rule**, so per-crawl cost multiplies by every crawl ever run. An
uncapped multiple at `page_limit = 10000` would be 100,000 rows per crawl, and a
hundred crawls of one site becomes a storage conversation nobody chose to have.

**The property that makes the ceiling safe:** it is always greater than or equal
to `page_limit`, asserted by test. The ceiling can never be the thing that stops
a crawl reaching its configured page count.

### Hitting the ceiling is not a correctness failure

Once `page_limit` is already binding, the 5,001st discovery changes nothing that
will happen: if 5,000 URLs are known and 500 may be fetched, more discovery adds
no reachable work.

What it does cost is **honesty**. The crawl no longer knows its true discovered
total, so truncation is reported rather than silent: `EnqueueSummary.unrecorded`
counts candidates the ceiling left no room for.

⚠️ **This is not yet recorded durably.** `crawls` has no `frontier_truncated`
column, so a truncated crawl currently reports its discovery count with nothing
saying it was cut. Naming it as a gap rather than adding a migration outside this
brief's scope: the fix is one boolean column, and the crawl-driving job — which
does not exist yet — is where it must be written.

## Decision 3 — depth exhaustion is distinguishable from an empty frontier

A crawl loop stops for one of four reasons: `budget_exhausted`,
`depth_exhausted`, `frontier_empty`, `cancelled`.

Depth never terminates a loop directly — a too-deep URL is refused at enqueue, so
the loop ends by running out of work. Reporting that as `frontier_empty` would be
true and useless: _"we stopped because the site is deeper than you allowed"_ and
_"we stopped because we had seen everything"_ are different answers, and only the
first is a reason to change a setting.

**Cancellation is checked first, and wins over everything.** A cancelled crawl
that also exhausted its budget is `cancelled` — that is what the operator did,
and reporting `completed` because the arithmetic also worked out would be a lie
about who decided.

## Decision 4 — robots is consulted before enqueueing

A disallowed URL never enters the frontier as work. It is recorded as `skipped`
with `robots_disallowed` and the deciding rule.

Checking after dequeue would mean the fetch budget was spent on URLs that were
never going to be fetched, and a crawl of a site that disallows most of itself
would report "500 queued, 12 fetched" with nothing saying why.

The check order — identity, scope, depth, robots, budget, ceiling — is itself a
decision. **Scope precedes robots** because evaluating a third party's robots
rules would mean fetching _their_ `robots.txt`, which is the request scope exists
to prevent.

## Alternatives considered

**Reading (1), `page_limit` caps all rows.** Bounds storage for free and breaks
the operator's budget. Rejected above.

**No ceiling; rely on the HTML extractor's per-page anchor cap.** The extractor
will cap anchors, which bounds discovery _per page_ — and a thousand pages each
contributing a capped fifty links still reaches fifty thousand. It also makes the
frontier's safety depend on a module that does not exist yet.

**A flat 10,000-row ceiling for every crawl.** Simpler, and wrong at both ends:
generous enough to be pointless for a 10-page crawl, tight enough to truncate a
legitimate 10,000-page one.

**Delete skipped rows once the crawl completes.** Bounds storage and destroys the
"we found 900, fetched 500" statement, which is the reason they are recorded.

## Consequences

### Positive

- `page_limit` means what it says, identically for every site.
- Storage per crawl is bounded, and the bound scales with configuration.
- Discovery truncation is a reported fact rather than a silent shortfall.
- Termination reasons an operator can act on.

### Negative

- Two limits instead of one, and the second is not operator-visible. Accepted:
  the ceiling should never be reached by a legitimate crawl, and an operator who
  can see it is an operator who will try to raise it.
- The `× 10` factor is reasoned, not measured. Revisit after real crawls.
- `frontier_truncated` is not persisted yet, so today the flag exists only in the
  return value.
- A duplicate costs a read. The frontier now queries which candidate URLs already
  exist before deciding, rather than letting the unique index reject them — see
  below.

## Verification

`packages/crawler/src/frontier` — **41 unit tests** on the pure decision, **23
integration tests** against a real database as the restricted non-owner role.

All four termination conditions proved separately. A synthetic nine-node graph
with two cycles, a self-link and four alternative spellings of the root
terminates on its own and fetches each page exactly once. Cancellation keeps
fetched pages, leaves nothing `queued` or `fetching`, records the pending URLs as
`cancelled` rather than deleting them, and sets the crawl's status to
`cancelled`.

### ⚠️ A bug this ADR's own reasoning caused, and the test that now guards it

The first implementation decided every candidate and let the unique index reject
duplicates — **after** the running budget counter had been incremented for them.
Every page links back to the root and its siblings, so a page with ten links of
which eight were already known spent eight units of a budget it never used. A
crawl configured for 4 pages fetched 1 and then reported the frontier empty.

Caught by the page-limit integration test, not by review. The fix normalises and
deduplicates against the frontier _before_ deciding: a duplicate is not a
decision, it is a no-op, and it must cost nothing. `onConflictDoNothing` remains
because the read is not a lock — the index is the guarantee, the read is the
optimisation.

## Revisit when

- Real crawls exist and the discovery-per-page ratio can be measured.
- The crawl-driving job lands — `frontier_truncated` belongs in the same change.

## Related

- [ADR-0034](ADR-0034-crawl-storage-model.md) — the durable page identity results attach to
- [ADR-0035](ADR-0035-robots-and-politeness.md) — fail-closed, consulted here before enqueue
- [ADR-0033](ADR-0033-url-normalisation.md) — the one definition deduplication compares
