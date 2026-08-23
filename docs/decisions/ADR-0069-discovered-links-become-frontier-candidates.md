# ADR-0069 — Discovered links become frontier candidates

**Status:** Accepted
**Date:** 2026-08-23

## Context

With `fetchPage` returning links (ADR-0068) and `markFetched` returning the
observation id (ADR-0067), the crawl loop finally holds everything needed to
write `crawl_links` and to discover pages from links rather than only from the
seed and sitemaps.

That leaves three questions the existing code does not already answer.

## Decision 1 — every link is recorded; only internal links are offered

**All links go into `crawl_links`.** External targets, other subdomains,
`nofollow` — every edge the document stated. They are facts (§5), and the
questions the table exists for ("what links here?", "is this page orphaned?",
"what does this site link out to?") cannot be answered from a filtered subset.

**Only `scope === 'internal'` links are offered to the frontier.**

This is not a second scope rule. The verdict is `link.scope`, which
`extractLinks` obtained from the single `classifyScope` — §5's "URL identity is
singular" holds, and nothing is re-decided. Out-of-scope links are simply not
offered.

`decideEnqueue` would refuse them anyway, and that is precisely the argument
for not offering them. A refusal is **recorded**, and a recorded refusal costs
a frontier row. `frontierRowCeiling` bounds the table so that "one page linking
to ten thousand distinct filtered URLs" cannot write ten thousand rows — and a
site's outbound links are exactly that shape. Offering them would spend the
ceiling the crawl needs for the customer's own pages, to record a fact
`crawl_links` now records better and durably.

## Decision 2 — `nofollow` is recorded and NOT filtered

`is_nofollow` is stored on every link. It does not affect enqueueing.

`nofollow` tells a search engine not to pass ranking weight. It does not tell a
site's own auditor not to look, and this crawler audits the customer's own
site. A `nofollow`-ed internal page — a filtered listing, a legacy section
somebody quietly de-emphasised — is close to the definition of what an audit
should surface.

Making it an admission rule would be a change to `decideEnqueue`, which owns
every admission decision, and would need its own skip reason so an operator
could see why a page was not fetched. That is a deliberate decision with a
schema consequence, not a filter to smuggle into a link mapper.

## Decision 3 — links are written only when the observation was created

The link write and the enqueue are both gated on `markFetched` returning a
non-null `crawlPageId`.

ADR-0067 establishes what the id means: non-null is "this attempt created the
observation", null is "this page was already recorded in this crawl". Because
`recordLinks` runs in the caller's transaction — the same one `markFetched`
wrote in — the observation and its links commit together. So "the observation
exists" implies "its links exist", and a redelivered page job can safely skip
both.

Without the gate, at-least-once delivery would write a second complete copy of
every link on the page, silently, since `crawl_links` has no unique index to
refuse it.

The enqueue is gated too, though duplicates there are already harmless
(`crawl_frontier` has a unique index and `enqueueDiscovered` charges nothing
for a duplicate). Gating both keeps one rule — "a redelivery does nothing" —
rather than two behaviours to reason about.

## Alternatives considered

**A. Offer every link to `decideEnqueue` and let it refuse the external ones.**
Rejected on the row ceiling, above. It also makes `crawl_frontier` the second
place a site's outbound link graph is recorded, in a lossier form and with a
lifetime tied to one crawl.

**B. Skip `nofollow` links when enqueueing.**
Rejected: see Decision 2. Recorded here so a future session finds the argument
rather than re-deriving it, and knows the change belongs in `decideEnqueue`.

**C. Deduplicate links before insert.**
Rejected. A page linking to `/contact` from its nav and its footer stated two
edges with different anchor text, and both are facts. Collapsing them makes an
anchor-text distribution — a thing ADR-0034's storage argument explicitly
anticipates wanting — uncomputable.

**D. Put `recordLinks` in `frontier.ts`, next to `markFetched`.**
Rejected. The frontier is what will be fetched; the link graph is what a
document said. They share a transaction, not a responsibility, and
`crawl_links` outlives every question the frontier answers.

## Consequences

- A crawl of a site with no sitemap discovers pages. This is the behaviour
  `runCrawl`'s header called a stated limitation since ADR-0053.
- `crawl_links` has a writer for the first time since migration 0008 created
  it.
- `crawl_frontier.discovered_from` has its first real value. It is a uuid
  self-reference to `crawl_frontier.id`; the page that stated the links was
  itself claimed from the frontier, so there is a row to point at — unlike the
  sitemap path, where `null` remains the honest value.
- Link depth is `source.depth + 1`, which `decideEnqueue` compares against
  `maxDepth` verbatim. A shallow `maxDepth` now bites where before only the
  sitemap's flat depth-0 candidates existed.
- No migration. `crawl_links` already had RLS `ENABLE` + `FORCE` and an
  `INSERT` policy.

## What this does NOT decide

Whether `<link rel>`, `<area href>`, canonicals or `<iframe src>` are links.
`extractLinks` reads `<a href>` only (ADR-0066), and that is unchanged here.
