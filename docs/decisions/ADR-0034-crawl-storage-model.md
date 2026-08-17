# ADR-0034 — Page identity is separate from page facts

**Status:** Accepted
**Date:** 2026-08-17

> **Numbering note.** An earlier brief called for this to be ADR-0030. That
> number is taken by [ADR-0030](ADR-0030-worker-and-queue.md) (Stage 3, the
> worker and queue). 0034 is used because `packages/database/src/schema/crawl.ts`
> already cites it.

## Context

Stage 4 crawls a customer's website and records what it found. The obvious model
is one table: a row per URL per crawl, holding both the URL and everything the
crawl learned about it — status, title, canonical, word count.

That model was written, generated as migration 0008, and reviewed before it was
committed. It has one flaw, and the flaw is not visible until the second crawl:

**A page's identity would be scoped to a crawl.**
`crawl_pages` was unique on `(crawl_id, normalised_url)`. `/about` crawled
eleven times was eleven rows with no anchor tying them together, other than a
string comparison on the URL.

That works for "show me this crawl's pages". It does not work for the question
the product exists to answer:

> **What changed between crawl 12 and crawl 13?**

Answering it by joining on `normalised_url` across crawls is possible and
fragile: there is no entity to attach anything to, nothing to record that a page
was first seen in March, and no row that survives the crawl that discovered it.
The repository's own operating contract names this shape directly — *"page rows
scoped only to a `crawl_id` make change detection a migration and a backfill
later"*.

The cost of fixing it was asymmetric in a way that decided the matter. Migration
0008 was uncommitted and had been applied to nothing but a throwaway probe
database. Today the change is a schema edit. After the first customer crawl it
is a migration plus a backfill over every page of every site.

## Decision

**Two tables, because there are two kinds of statement.**

```
site_pages     one row per URL per site, for all time      IDENTITY
   ▲
   │ site_page_id
   │
crawl_pages    one row per URL per crawl                   OBSERVATION
```

| | `site_pages` | `crawl_pages` |
| --- | --- | --- |
| Unique on | `(site_id, normalised_url)` | `(crawl_id, normalised_url)` |
| Lifetime | Survives every crawl | Belongs to one crawl |
| Answers | "Is there a page at /about, and since when?" | "What did /about say on 14 August?" |
| Carries | Identity and lifecycle only | Every fact |

`site_pages` holds `first_seen_at` and `last_seen_at` and nothing else. Both are
facts about **our knowledge of the page**, not about the page.

### ⚠️ Why no facts live on `site_pages`

This is the part a future contributor will be tempted to collapse, so it is
stated as a rule rather than a preference.

It is very tempting to put "the last known title" on the identity row. It saves
a join on the page list, it reads naturally, and it is wrong:

- **It makes the product's central question unanswerable.** "When did the title
  change?" requires every crawl's title to be its own row. A single latest-value
  column can only ever say what it is now.
- **One fact is a rule; two is an argument.** Once `title` is there, `http_status`
  has an equally good case, then `word_count`. There is no principled place to
  stop, and the identity table becomes a mutable summary.
- **A denormalised summary drifts.** It is updated by one code path and read by
  another, and the first time a crawl fails halfway the summary disagrees with
  the observations underneath it — with no way to tell which is right.

**The rule: if a crawl could observe it differently next time, it is a fact and
it belongs to the observation.**

`last_seen_at` passes that test only because it is not about the page at all —
it is about when we last looked, which is a property of the crawling, not of the
site.

### Why `crawl_pages` keeps its own unique constraint

`(crawl_id, normalised_url)` stays. The queue is at-least-once, so a page job
will sometimes run twice; without it, a retry writes a second observation and
doubles every count on the summary. Writes upsert through it, which makes retry
idempotent by construction rather than by a check someone remembered.

Two constraints, two statements: **one page, ever** and **one observation per
crawl**. Neither replaces the other.

### Why `site_page_id` is nullable

A fetch that fails before the URL is resolved still records the attempt. Every
successful fetch attaches to an identity row; a refusal that never got that far
is still evidence and should not be dropped to satisfy a foreign key.

## Alternatives considered

**One table, keyed `(site_id, normalised_url)`, overwritten each crawl.**
Smallest schema, and it destroys the history that is the entire product. "What
changed?" becomes unanswerable by construction.

**One table keyed `(crawl_id, normalised_url)`, join on the URL string across
crawls.** What was originally built. It technically supports change detection
and gives nothing to hang lifecycle on — no first-seen, no place for a future
page-level annotation, and every consumer re-deriving identity from a string.

**Add `site_pages` later, when change detection is built.** The honest version
of "we will fix it in Stage 5". By then it is a migration and a backfill over
customer data, and the shape of the backfill is guesswork: `first_seen_at` for a
page discovered before the table existed can only be approximated.

**Put a `latest_*` summary on `site_pages` as a cache.** Rejected above. If page
lists prove slow, the answer is an index or a materialised view derived from the
observations — something that cannot disagree with its source.

## Consequences

### Positive

- Change detection is a query, not a migration.
- A page has somewhere to live between crawls, which later stages need for
  annotations, ignore-rules and per-page targets.
- `first_seen_at` is real from the first row rather than backfilled from a guess.
- The identity/observation split is enforced by two unique constraints in the
  database, not by convention.

### Negative

- One more table, one more join for the common "list this crawl's pages" query.
  Accepted: the join is on an indexed foreign key.
- Writing a page result now touches two tables, so it must be one transaction.
  A page whose discovered links vanished because the worker died between two
  unrelated transactions is exactly the failure this must not have.
- `site_pages` grows monotonically and has no retention rule. Deliberately: no
  rule has been decided, and inventing one so the table looks handled is how
  customer data gets deleted on a schedule nobody agreed to
  ([ADR-0013](ADR-0013-audit-trail.md)'s open gap, applied here).

## Verification

Migration 0008 applied from zero on a throwaway database, then destroyed:

- 26 workspace-owned tables `ENABLE` **and** `FORCE`; the only exception remains
  `memberships` ([tenant-isolation.md](../security/tenant-isolation.md))
- `site_pages` — RLS enabled and forced, 3 policies, no DELETE policy
- Refused: a duplicate `(site_id, normalised_url)`; `last_seen_at` before
  `first_seen_at`; an empty URL
- One durable page, two crawls, two observations, two distinct titles — the
  change is visible in the data

## Revisit when

- A page-level annotation (ignore, priority, owner) is needed — it belongs on
  `site_pages`, and this is the ADR that says so.
- `site_pages` growth becomes a storage question, at which point retention is a
  decision to be made explicitly rather than assumed.

## Related

- [ADR-0029](ADR-0029-web-properties.md) — the `sites` model this hangs from
- [ADR-0021](ADR-0021-ingestion-and-idempotency.md) — the same at-least-once
  reasoning behind `crawl_pages`' unique constraint
- `AGENTS.md` §5, architectural horizon 1
