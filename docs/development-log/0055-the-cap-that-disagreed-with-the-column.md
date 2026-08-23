# 0055 — The cap that disagreed with the column

**Date:** 2026-08-23 · **Stage:** 4

## Objective

Wire `extractLinks` into the crawl — persist links to `crawl_links`, enqueue
in-scope internal links into the frontier — so a sitemap-less crawl discovers
more than its seed. Dev log [0054](0054-the-second-classifyscope.md)'s
"Remaining work" item 1.

## Initial state

Verified, not recalled: `dfc08f4`, tree clean, `## main...origin/main`, and
`origin/main` at the same commit.

- `npm test` bare → **1617 passed / 361 skipped (1978)**, 45 files / 19 skipped
- `.env.local` sourced → **1978 passed (1978)**, 64 files
- `npm run verify:all` → exit 0, 1978 passed, **32 boundaries**, gitignore clean
- `npm run verify:e2e` → **77 passed**

PostgreSQL by **`-D` data directory** ([0045](0045-a-preflight-that-lied.md)):
`55432` → `~/.growth-os/pgdata` (PID 11424). `55433` → an unrelated project.

## ⚠️ Two corrections to 0054, before building on it

0054 is the record this session started from, and two of its statements do not
survive re-measurement. Neither changes its conclusion — the SEO Agent is still
Stage 8 with unmet dependencies, Stage 5 still has no implementation — but both
are the kind of claim a later session would reason from.

**"'Phase 0' appears only inside ADR prose describing a session brief"
([0054](0054-the-second-classifyscope.md):28) is false.** `grep -rniE
"phase[ _-]?[01]\b"` finds it in shipped source and in a migration:
`packages/database/src/schema/agents.ts:22` and `:204`,
`packages/database/migrations/0014_agent_platform.sql:137`,
`packages/guardrails/src/pipeline.ts:11`, `packages/guardrails/src/self-duplication.ts`.
The _"Phase 1"_ half holds: it appears nowhere but in the two sentences of 0054
that deny it.

**"Stages 0–22" is off by one and omits a fraction.** The roadmap runs Stage 0
through `docs/product/product-roadmap.md:553` "## Stage 23 — Production scale &
hardening ⬜", and contains a non-integer `## Stage 2.5`.

**And one correction to [ADR-0066](../decisions/ADR-0066-html-link-extraction.md).**
`links/extract.ts:15` reads "⚠️ NO RAW HTML LEAVES THIS MODULE (ADR-0034)".
[ADR-0034](../decisions/ADR-0034-crawl-storage-model.md) is titled _"Page
identity is separate from page facts"_ and contains no occurrence of "HTML",
"raw", "escape" or "body" — the property is real and worth keeping, but that
ADR is not its authority. Recorded, not yet fixed.

## ⚠️ The finding: the extractor's cap was above the column's

`extractLinks` capped anchor text at **512** characters
(`links/extract.ts:48`). `crawl_links` refuses anything over **300**:

```sql
-- 0008_website_crawler.sql:258-263
-- ⚠️ ANCHOR TEXT IS ARBITRARY PUBLIC CONTENT FROM A THIRD PARTY'S WEBSITE.
-- Capped in the database as well as in the extractor, so a bug in one cannot
-- put a megabyte of somebody's page body into a column.
ALTER TABLE "crawl_links"
  ADD CONSTRAINT "crawl_links_anchor_text_is_bounded"
  CHECK ("anchor_text" IS NULL OR length("anchor_text") <= 300);
```

The migration's own comment says the two caps exist so that _"a bug in one
cannot"_ reach the column. They were meant to agree, and they did not.

This was harmless for exactly as long as nothing inserted a link. The first
anchor between 301 and 512 characters — one long call-to-action on one page of
one customer's site — would have been produced happily by the extractor and
then refused by the CHECK, rolling back the entire page transaction,
`markFetched` included. The page would have been re-claimed, re-fetched, and
failed the same way until its retry ceiling.

**AGENTS.md §5 decides which number moves.** _"Limits live in the database."_
The extractor comes down to 300; the constraint is not relaxed to 512.

### Why the existing test could not catch it

`extract.test.ts` already had a cap test, and it passed at 512:

```ts
const [link] = extractLinks(`<a href="/x">${'y'.repeat(MAX_ANCHOR_TEXT_LENGTH * 4)}</a>`, …);
expect(link?.anchorText?.length).toBe(MAX_ANCHOR_TEXT_LENGTH);
```

It compares the extractor's output against **the same constant that produced
it**. It is a tautology: it passes for any value, including one the database
refuses. It is left in place — capping at all is still worth asserting — and
two tests were added beside it that compare against the database's bound
written as a literal, with the migration line quoted as its authority.
Importing the extractor's constant into those would rebuild the tautology.

**Mutation-tested.** Restoring `512`:

| Mutation                       | Result                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `MAX_ANCHOR_TEXT_LENGTH` → 512 | 2 tests failed ✓ — and the pre-existing cap test still PASSED, which is the point |

Restored green at **62 tests** in `extract.test.ts` (60 before).

## ⚠️ Slice 2 — the id was missing, and so was the idempotency it implies

`crawl_links.source_page_id` references `crawl_pages.id`. `markFetched` — the
only code that inserts a `crawl_pages` row — returned `{ sitePageId }`, which
is `site_pages.id`: a different table, a different lifetime (ADR-0034). At the
one place a link would be written, the id it must reference was not in scope.

Fixing that alone would have shipped a worse bug than it fixed. `crawl_pages`
absorbs the queue's at-least-once delivery with a unique index and
`ON CONFLICT DO NOTHING`. **`crawl_links` has no unique index** — only two
non-unique ones — and no natural unique key: a page linking to `/contact` from
both the nav and the footer is two real edges with different anchor text.
A retried page job would have written a second complete copy of every link on
the page, silently, because nothing would error.

Nor could it be cleaned up: `crawl_links` has RLS `ENABLE` + `FORCE` with only
`SELECT` and `INSERT` policies (`0008:321-326`). Under the restricted role a
delete-then-reinsert is not discouraged, it is impossible.

**Both problems have one answer.** `ON CONFLICT DO NOTHING ... RETURNING id`
returns the row when the insert happened and **nothing** when the conflict
fired. Measured against `~/.growth-os/pgdata` before relying on it:

```
INSERT … ON CONFLICT (k) DO NOTHING RETURNING id;  →  1 row   (INSERT 0 1)
INSERT … ON CONFLICT (k) DO NOTHING RETURNING id;  →  0 rows  (INSERT 0 0)
```

So `crawlPageId === null` means exactly "already recorded in this crawl", and
gating the link write on it makes link persistence idempotent **without** a
unique index, without a `DELETE` policy, and without a migration. The conflict
clause is untouched; `RETURNING` adds a signal, it does not change what is
written. Since `markFetched` uses the caller's transaction, observation and
links commit together — there is no window where one exists without the other.

This was not novel: `enqueueDiscovered` (`frontier.ts:194-205`) has always told
a duplicate from an insert this same way. [ADR-0067](../decisions/ADR-0067-the-observation-id-is-the-retry-signal.md)
records the decision and why `ON CONFLICT DO UPDATE` — the obvious fix — is the
one alternative that actively destroys the signal.

**Mutation-tested:**

| Mutation                                          | Result           |
| ------------------------------------------------- | ---------------- |
| `crawlPageId` never null (ADR-0067 alternative A) | 1 test failed ✓  |
| `RETURNING` dropped, so it is always null         | 2 tests failed ✓ |

Restored green at **32 tests** in `frontier.integration.test.ts` (30 before).

## Slice 3 — the design question answered by two files already in the package

`fetchPage` held the HTML — it reads the body to measure `contentLength` — and
discarded it. The extractor could not be called from anywhere.

The obvious fix is "return the body and let `runCrawl` call `extractLinks`",
and it is wrong. `robots/fetch.ts` and `sitemap/fetch.ts` both decode their own
body, hand it to their own parser, and return the PARSED result beside the
response facts:

| module             | returns        | facts                      | parsed     |
| ------------------ | -------------- | -------------------------- | ---------- |
| `robots/fetch.ts`  | `RobotsState`  | `outcome`, `detail`, `url` | `rules`    |
| `sitemap/fetch.ts` | `SitemapState` | `outcome`, `detail`, `url` | `document` |
| `pages/fetch.ts`   | `PageState`    | `observation`              | `links`    |

The shape was not a judgement call — it was already the package's answer,
twice. `fetchPage` was the odd one out only because extraction did not exist.
[ADR-0068](../decisions/ADR-0068-the-page-fetch-returns-parsed-state.md).

**`observation` and `links` are siblings, not nested**, and that is load-bearing.
`PageObservation` is spread straight into `crawl_pages` by `markFetched`, so
every field on it must be a column. Nesting `links` inside it would have needed
a second `undefined` exception at the call site beside the one `bytes` already
has.

### The test that failed, and was wrong

`a missing content-type is not treated as HTML` failed on first run: links came
back. `FixtureTransport` substitutes `text/html; charset=utf-8` when `headers`
is **omitted** (`packages/net/src/testing/fixtures.ts:168`), so the fixture was
asserting the opposite of its own name. `headers: {}` is what expresses "no
content-type". The code was right and the test was wrong — recorded because the
next person writing a fixture without headers will believe they have no
content-type too.

**Mutation-tested:**

| Mutation                                        | Result           |
| ----------------------------------------------- | ---------------- |
| content-type gate removed (scan every body)     | 2 tests failed ✓ |
| base URL is the requested one, not the final    | 1 test failed ✓  |
| scope gate removed, so parsing is unconditional | 1 test failed ✓  |

Restored green at **29 tests** in `fetch.test.ts` (20 before).

## Remaining work

Nothing writes `crawl_links` or enqueues a discovered link. `runCrawl`
destructures `{ observation }` and does not yet pass a scope, so a sitemap-less
crawl still returns one page.
