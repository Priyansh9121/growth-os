# ADR-0067 — The observation id is the retry signal

**Status:** Accepted
**Date:** 2026-08-23

## Context

`crawl_links` has existed since `0008_website_crawler.sql` and has never been
written by anything. Giving it a writer surfaced two constraints that had never
had to hold at the same time.

**1. The id it references is not returned by the function that creates it.**
`crawl_links.source_page_id` references `crawl_pages.id`
(`schema/crawl.ts:447-449`). `markFetched` — the only code that inserts a
`crawl_pages` row — returned `{ sitePageId }`, the `site_pages` id, which is a
different table and a different lifetime (ADR-0034). At the one place a link
would be written, the id it must reference was not in scope.

**2. `crawl_links` has no unique index, and cannot easily be given one.**
`crawl_pages` makes a retried page job idempotent with a unique index on
`(crawl_id, normalised_url)` and `ON CONFLICT DO NOTHING` — ADR-0034 records
why. `crawl_links` has only two NON-unique indexes
(`crawl_links_source_idx`, `crawl_links_target_idx`) and no natural unique key:
a page may legitimately link to the same target twice with different anchor
text, so `(crawl_id, source_page_id, target_url)` is not unique in the data,
and adding a surrogate uniqueness that the data does not have would refuse rows
the crawl correctly observed.

Deletion is not an escape either. `crawl_links` has RLS `ENABLE` and `FORCE`
with **only** `SELECT` and `INSERT` policies
(`0008_website_crawler.sql:321-326`). Under the restricted role a
delete-then-reinsert is not merely discouraged, it is impossible.

So the queue's at-least-once delivery, which `crawl_pages` absorbs harmlessly,
would have written a second complete copy of every link on the page — silently,
because nothing would error.

## Decision

**`markFetched` returns `crawl_pages.id`, and `null` when the row already
existed. Links are written only when it is non-null.**

`ON CONFLICT DO NOTHING ... RETURNING id` returns the inserted row when the
insert happened and **no row at all** when the conflict target fired. Measured
against the project cluster before relying on it:

```
INSERT INTO probe (k) VALUES ('a') ON CONFLICT (k) DO NOTHING RETURNING id;
  →  1 row      (INSERT 0 1)
INSERT INTO probe (k) VALUES ('a') ON CONFLICT (k) DO NOTHING RETURNING id;
  →  0 rows     (INSERT 0 0)
SELECT count(*) FROM probe;  →  1
```

This is not new behaviour in this codebase: `enqueueDiscovered`
(`frontier/frontier.ts:194-205`) already distinguishes a duplicate from an
insert exactly this way, and its `duplicates` count is derived from it.

The conflict clause on `crawl_pages` is unchanged. `RETURNING` adds a signal;
it does not alter what the statement writes.

Because `markFetched` takes the caller's transaction rather than opening its
own, "the observation exists" and "its links exist" are the same commit. There
is no window in which a crawler could see a `crawl_pages` row whose links were
never written, so gating on the id is sound rather than merely convenient.

## Alternatives considered

**A. `ON CONFLICT DO UPDATE` with a no-op `SET`, so a row always returns.**
Rejected. It would return the id on both paths, which destroys the very signal
being sought — the caller could no longer tell a first write from a retry, and
would write the links twice. It also converts every retry into a real row
update, taking a row lock and bumping the heap for no reason.

**B. A unique index on `crawl_links`, mirroring `crawl_pages`.**
Rejected. There is no unique key in the data. A page linking to `/contact`
twice — once in the nav, once in the footer, with different anchor text — is
ordinary, and both edges are facts. A unique constraint would refuse the second
and make the link graph quietly lossy. Anchor text cannot go in the key either:
it is nullable and capped, so two long anchors differing past the cap would
collide.

**C. Delete this crawl's links for the page, then insert.**
Rejected as impossible before it was rejected as unwise: there is no `DELETE`
policy on `crawl_links`, and RLS is `FORCE`. Making it possible means a
migration adding a policy that widens what a compromised application role can
destroy — a large security concession to solve a problem that a returned id
solves for free.

**D. Count existing links for the page and skip when non-zero.**
Rejected. A read-then-write with no lock, which is the race
`enqueueDiscovered` documents at length. It also cannot distinguish "already
written" from "written and genuinely empty" — a page with no links at all is
common, and would be re-examined on every retry.

## Consequences

- `markFetched`'s return type gains `crawlPageId: string | null`. Existing
  callers destructure `sitePageId` and are unaffected.
- A caller that writes something hanging off the observation MUST gate on the
  id. The type makes the retry case unignorable — it is `| null`, so the
  compiler asks.
- The link table stays free of a uniqueness claim its data does not support.
- No migration. No RLS change. No new policy surface.

## What this does NOT decide

Whether a page's links should be _re-observed_ on a later crawl. They are: a
new crawl means a new `crawl_pages` row, so `crawlPageId` is non-null and the
links are written afresh against that crawl. This ADR is about a retry of the
same page in the same crawl, which is the case at-least-once delivery creates.
