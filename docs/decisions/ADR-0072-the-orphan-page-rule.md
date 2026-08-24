# ADR-0072 — The orphan page rule, and the three predicates that decide it

**Status:** Accepted
**Date:** 2026-08-24

## Context

`orphan_page` is the audit layer's first rule (ADR-0071 gives it a package,
ADR-0070 gives it a table). It was chosen because it is the only interesting
question the currently-recorded facts can actually answer: it needs the **link
graph**, which `crawl_links` has held since dev log 0055 gave it a writer, and
nothing else in Stage 5's list does.

A rule like "missing title" would need only `crawl_pages` and would not exercise
the graph at all; a rule about ranking or keywords needs data no stage has
gathered yet. Orphan pages also has the property that makes it worth testing
first: it is a **join**, so getting it wrong is quiet rather than loud.

"A page nothing links to" sounds unambiguous. It is not, and three predicates
decide what it means. Each was measured; two of them contradicted the brief.

## Decision 1 — the population is pages RETRIEVED, not pages crawled

`outcome IN ('fetched', 'unchanged')`.

**The brief said "out of N pages crawled". That is wrong**, because
`crawl_pages` holds a row for every _attempt_: `http_4xx`, `http_5xx`,
`blocked`, `redirected` and `failed` all get rows, deliberately, because a
failed fetch is still evidence (ADR-0034).

A 404 has no content, states no links, and cannot be orphaned. Counting the
failures would do two separate kinds of damage: it inflates the denominator, so
"0 of 90" understates how connected a 42-page site is; and it emits an
`orphan_page` finding for **every broken URL the site links to**, which is both
wrong and the most annoying possible false positive — the audit would report
that a page nobody can reach is not linked to.

`unchanged` is a 304. The page exists and its facts were carried forward from
the previous crawl, so it is retrieved in every sense this rule cares about.
Excluding it would make a page's orphan status flip on and off with the cache.

## Decision 2 — a self-link is not an inbound link

`crawl_links.source_page_id <> crawl_pages.id`.

**This was not in the brief at all**, and without it the rule under-reports
exactly the pages it exists to find.

Almost every page links to itself: a logo in the header pointing at `/`, a
breadcrumb whose last segment is the current page, a nav item marked "current"
that is still an `<a href>`. `extractLinks` records all of them, correctly —
they are facts the document stated.

But a page whose _only_ internal inbound link comes from itself is still
unreachable from the rest of the site, which is the entire condition being
detected. Counting a self-link would rescue precisely the orphans that have a
site-wide header.

The comparison is between `crawl_links.source_page_id` and `crawl_pages.id` —
both `crawl_pages` identities, per that column's foreign key. Comparing against
`site_page_id` would be a different and wrong question, since it would also
discard a _previous_ crawl's link from the same durable page.

## Decision 3 — only `scope = 'internal'` counts, read and never recomputed

An orphan is a page **the site itself** does not link to. An inbound link from
another domain, or from another subdomain, does not make a page part of this
site's navigation, which is what the rule measures.

⚠️ **The scope is read from the column, not decided here.** `crawl_links.scope`
is the verdict of the single `classifyScope`, and `crawl_links.target_url` was
normalised by the single `normaliseUrl` before it was ever recorded
(`links/extract.ts:330`). The join is therefore a plain text equality against
`crawl_pages.normalised_url`, and it is sound _because_ both sides went through
the same function.

This is the §5 invariant "URL identity is singular", and it is the reason the
rule contains no URL code whatsoever. Dev log 0054 records a session that wrote
a second `classifyScope` before finding the first; ADR-0071 explains why not
depending on `@growth-os/crawler` is not a licence to re-derive its logic. The
check that this held is simply that `packages/seo` imports no URL helper and
defines none.

## Decision 4 — the evidence, and what is deliberately not in it

`{ internalInboundLinks: 0, pagesConsidered: N }`.

`internalInboundLinks` is literally zero rather than a count that happens to be
zero: `findOrphanPages` returns only pages with no inbound link, so the value is
a property of membership in that set. A rule reporting "few inbound links" would
need a real count and a threshold, and that is a different rule with a different
name and its own ADR.

`pagesConsidered` is the denominator that makes the zero legible. "0 inbound
links out of 3 pages retrieved" is barely a finding; "0 out of 400" is a serious
one. It is the _population_, not the orphan count — reusing the orphan count
would make every finding read "0 out of 1".

Nothing else is in the row. No severity, no message, no recommendation
(ADR-0070, decision D).

## Decision 5 — a re-audit writes nothing, and says so

The write is `ON CONFLICT DO NOTHING ... RETURNING`, against
`seo_findings_crawl_page_rule_unique`, and `recordOrphanPages` returns
`orphansFound` and `findingsWritten` separately.

The unique index already makes a re-audit idempotent (ADR-0070). `RETURNING` on
a `DO NOTHING` insert is what makes that _observable_: a second audit of the
same crawl reports the same `orphansFound` and `findingsWritten: 0`. This is the
signal ADR-0067 established for `markFetched`, reused rather than reinvented.

Inserts are chunked at 500 rows. Each finding binds 5 parameters against
PostgreSQL's 65535 ceiling, and `crawls_budget_is_bounded` caps `page_limit` at
10,000 — so the worst case is 50,000 parameters: under the limit today and over
it as soon as the row grows a sixth and seventh column. Chunking makes that
coupling not exist, exactly as `recordLinks` does.

## Alternatives considered

**A. Count any inbound link, including self-links.** Rejected under Decision 2.
It is the version that looks right and finds almost nothing.

**B. Count inbound links from any scope.** Rejected under Decision 3. "Somebody
else links to it" is a different and also useful finding; it is not this one.

**C. Include `redirected` in the population.** Rejected. A 3xx row's target is
a separate frontier entry with its own `crawl_pages` row, so the destination is
already judged on its own. Counting the redirect too would double-count one
page and report a finding against a URL that is not a page.

**D. Exclude `nofollow` links from counting as inbound.** Rejected, consistent
with ADR-0069's decision 2: `nofollow` tells a search engine not to pass weight,
not a site's own auditor not to look. A `nofollow`-ed link still means the page
is reachable from the site's navigation, which is what is being measured.

**E. Compute the denominator with a separate `COUNT(*)`.** Rejected. One query
returning both means the numerator and denominator come from one snapshot; two
queries can disagree if anything writes between them.

## Consequences

- The first rule exists, and it consumes the link graph — which is what makes it
  a real test of the storage model rather than a placeholder.
- Six mutations were run against the implementation. Removing the self-link
  predicate, the outcome filter, the scope filter, the `ON CONFLICT` clause, or
  swapping the denominator for the orphan count each fails tests. Removing the
  `isNotNull(site_page_id)` guard **survived**, and a test was written to close
  it (see the dev log).
- Nothing calls `recordOrphanPages` in production. When to run an audit is
  ADR-0071's stated non-decision.

## What this does NOT decide

Any second rule. Severity or prioritisation of findings. Whether an orphan page
found by a crawl with a very small `page_limit` should be reported at all — the
denominator is recorded so that judgement can be made later, by the layer that
makes judgements.
