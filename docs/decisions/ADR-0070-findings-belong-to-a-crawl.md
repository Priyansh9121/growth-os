# ADR-0070 — Findings belong to a crawl

**Status:** Accepted
**Date:** 2026-08-24

## Context

Stage 5 needs somewhere to put what an audit rule concluded. The crawler
already records what a website _said_ — `crawl_pages` holds one observation per
URL per crawl, `crawl_links` holds every edge a document stated. Neither holds
an interpretation, deliberately: AGENTS.md §5 draws the stage boundary at
exactly that line.

`seo_findings` is the first table on the other side of it. Four questions had to
be answered before it could be written, and none of them has an obvious answer.

## Decision 1 — a finding is scoped to a crawl, not to a page

`seo_findings` rows are scoped per-crawl and never overwritten, exactly as
`crawl_pages` is, and they cascade away with the crawl.

ADR-0034 gives the test: _"if a crawl could observe it differently next time, it
is a fact and it belongs to the observation."_ A finding is derived **entirely**
from one crawl's rows. Re-run the crawl and the rule may decide differently,
because the facts it read may differ. So it is scoped where the facts are.

**The consequence is the reason this is worth an ADR.** A page that stops being
orphaned needs _nothing deleted and nothing updated_ — the next crawl simply
writes no `orphan_page` row for it. "The finding closed between crawl 12 and
crawl 13" is then readable from two crawls' rows.

The alternative — a durable finding with `resolved_at` — requires something to
notice the fix and write to it, and is silently wrong whenever that something
did not run. It converts a derived fact into mutable state whose correctness
depends on a background job, which is the class of bug that does not announce
itself.

## Decision 2 — the finding points at the DURABLE page

`site_page_id` references `site_pages`, not `crawl_pages`, and it is `NOT NULL`.

This is what makes a finding comparable across crawls. Two crawls'
`orphan_page` rows for the same page share this id, so "still orphaned in
March" is a query rather than a string comparison on a URL. Pointing at the
observation instead would scope the finding's **subject** to one crawl as well
as its lifetime, leaving nothing to compare — and would defeat the architectural
horizon's first constraint, that page identity is durable across crawls.

The nullability differs from `crawl_pages.site_page_id` on purpose. That column
is nullable so a fetch which failed before the URL resolved still records the
attempt; a failed fetch is still evidence. That reasoning does not carry over: a
finding about no particular page is not a finding.

## Decision 3 — `evidence` is a bounded `jsonb` object, not shared typed columns

`evidence jsonb NOT NULL`, with a CHECK requiring a non-empty JSON **object**
of at most 4096 bytes as text.

Typed columns were considered first — `observed` and `population` fit
`orphan_page` exactly (`0` inbound links out of `42` pages). They were rejected
because they would be a lie for the first rule that decides on a boolean, a
string, or three numbers. Inventing a common shape from a sample size of one
rule is the over-building §3 forbids; the honest statement today is "the
deciding facts differ per rule."

What a loose column must not become is a nullable bag. `jsonb NOT NULL` alone
accepts `42`, `"orphaned"`, JSON `null`, `[]` and `{}` — every one of which
satisfies the column type and none of which states what was measured. The CHECK
is what makes "a finding that decided nothing" unrepresentable rather than
merely discouraged.

The 4 KB ceiling follows `crawl_links_anchor_text_is_bounded`: a bug in a rule
must not be able to store a page of prose, and the place that stops it is the
one no application path can route around (§5, limits live in the database).

## Decision 4 — the row bound is a UNIQUE INDEX, because a CHECK cannot count

`seo_findings_crawl_page_rule_unique` on `(crawl_id, site_page_id, rule)`.

**The brief for this table asked for "at most N findings per crawl, bound via a
CHECK constraint, matching the pattern already used for `crawl_links`." Both
halves of that were wrong, and measurement is what showed it.**

- A CHECK constraint is evaluated against a single row and cannot count a
  table. "At most N per crawl" is not expressible as one.
- There is no such pattern on `crawl_links` to match. Its only CHECK bounds
  `anchor_text` to 300 characters; it has no row cap at all.

So the bound is structural instead, and it is a real one. A rule writes at most
one row per retrieved page; `crawl_pages_crawl_url_unique` allows at most one
row per URL per crawl; `crawls_budget_is_bounded` caps `page_limit` at 10,000.
The ceiling therefore exists and is enforced, and no arbitrary number had to be
invented to state it.

It is also the retry guarantee, exactly as `crawl_pages_crawl_url_unique` is:
re-auditing a crawl must be idempotent rather than a way to double every finding
on it. Writes go through it with `ON CONFLICT DO NOTHING`.

## Decision 5 — SELECT and INSERT policies only

RLS `ENABLE` + `FORCE`, with no UPDATE policy and no DELETE policy. The two
absences have different reasons.

**No UPDATE:** a finding is what a rule concluded from one crawl's facts, and a
conclusion that can be edited afterwards is not evidence of anything. If the
rule changes its mind, that is a new crawl's row.

**No DELETE:** a finding that stops being true does not need deleting, because
Decision 1 means the next crawl simply produces no row. Deleting this crawl's
row would erase the half of "the finding closed between crawl 12 and crawl 13"
that says it was ever open. Findings still disappear when their crawl does, via
`ON DELETE CASCADE` — the lifetime is the crawl's to end, not a caller's.

## Alternatives considered

**A. A durable `findings` table keyed on `site_page_id` with `resolved_at`.**
Rejected under Decision 1. It also makes re-auditing a completed crawl a
destructive operation rather than an idempotent one.

**B. `crawl_page_id` instead of `site_page_id`.**
Rejected under Decision 2. It is the cheaper join for the rule that writes the
row and the wrong one for every question asked afterwards.

**C. `observed` / `population` integer columns.**
Rejected under Decision 3. Recorded here so the next rule's author knows the
option was considered and why one rule was not enough evidence to generalise.

**D. A `severity` column.**
Rejected on §5 alone. Severity is a judgement about a finding, and it is a
product decision that will change without the facts changing. The table stores
what was measured; ranking it is a later deliverable and a different layer.

## Consequences

- Findings are cheap to recompute and impossible to double-count.
- "Is this still open?" is a two-crawl query, not a column.
- `packages/database/src/seo-isolation.integration.test.ts` proves the bound,
  the CHECK and the policy set against a real database as a non-owner role.
  Dropping the unique index, the CHECK, or `FORCE` each fails exactly the tests
  that claim to prove them — verified by mutation, not by inspection.
- A second rule needs no migration: it is a new enum member and a new `evidence`
  shape.

## What this does NOT decide

Severity, priority, ranking, or any human-readable rendering of a rule — see
Decision D and the header of `packages/contracts/src/seo/enums.ts`. Nor which
rules exist: `SEO_FINDING_RULES` has one member because one rule is
implemented.
