# 0054 — The second classifyScope

**Date:** 2026-08-23 · **Stage:** 4

## Objective

Decide what comes after four slices of agent-platform substrate, then build the
thing that decision picked: HTML link extraction.

## Initial state

Verified, not recalled: `94367f4`, tree clean, `## main...origin/main` in sync.

- `env -u TEST_DATABASE_URL npm test` → **1557 passed / 361 skipped (1918)**
- `.env.local` sourced → **1918 passed (1918)**, 63 files

PostgreSQL by **`-D` data directory** ([0045](0045-a-preflight-that-lied.md)):
`55432` → `~/.growth-os/pgdata` (PID 11424). `55433` → `~/Desktop/AI`,
unrelated.

## ⚠️ The brief's two options both rested on premises the repository contradicts

The handoff asked whether Phase 0 was complete — build the SEO Agent next, or
the approval-queue UI. Both framings dissolved on contact with the committed
record.

**There is no "Phase 0" or "Phase 1" in this repository.** The vocabulary is
**Stages 0–22**, in `docs/product/product-roadmap.md`. "Phase 0" appears only
inside ADR prose describing a session brief. §1 says do not reason from an
unverified premise, and "Phase 1 from the architecture doc" was one.

**The SEO Agent is Stage 8, and its own dependency line is unmet.** The roadmap
states: _"Dependencies: Stages 4–6 (there must be something to reason about)."_
Measured:

- **Stage 5 — the SEO audit engine, the facts→findings layer — does not exist.**
  No package, no code.
- **No HTML link extraction existed.** Every `href`/anchor hit in the crawler
  was a comment or robots pattern-matching.
- **`crawl_links` was written by nothing**, despite existing since 0008.

An agent consumes findings. The findings layer is not built and the facts
feeding it were thin — a crawl discovered pages only from seed and sitemap, so a
site without a sitemap yielded one page.

**`PROJECT-STATUS.md` is stale on one claim.** It says the crawler "has no
caller"; `apps/worker/src/jobs/run-crawl.ts:9` announces itself as _"THE FIRST
CALLER `@growth-os/crawler` HAS EVER HAD."_ Recorded here rather than fixed —
that file is maintained by its own audit process.

**A documentation inconsistency, unresolved:** `ai-agent-architecture.md:162`
says "What **Stage 7** adds" for the agent runtime, while the roadmap says
Stage 7 is _Keywords & rank tracking_ and Stage 8 is _Growth AI / SEO Agent_.

The choice was surfaced rather than defaulted into, and link extraction was
chosen — which is also `PROJECT-STATUS.md` §7's own recommendation.

## ⚠️ The finding: I wrote a second classifyScope

The extractor needs to label each link `internal` / `other_subdomain` /
`external`. Having measured that the repo has **no** public-suffix list and no
registrable-domain helper, I reasoned it out: sibling subdomains cannot be
proven related without a PSL, a two-label heuristic is actively wrong for
`.co.uk` (and this product's customers are UK businesses), so siblings must
classify as `external` — the safe direction. I wrote `classifyScope` and tested
it.

**`packages/crawler/src/urls/scope.ts` already exported a function called
`classifyScope`, with the same rule and a better argument for it** — that
`blog.example.com` is emphatically _not_ the same owner on `wordpress.com`,
`myshopify.com` or `github.io`, which are exactly the hosts small businesses
use.

Two functions of the same name that could disagree about what belongs to a site
is exactly what §5's _"URL identity is singular"_ forbids. The duplicate was
deleted before commit and `extractLinks` now takes a `CrawlScope` and maps the
existing verdict:

| `ScopeVerdict`    | `LinkScope`       |
| ----------------- | ----------------- |
| `in_scope`        | `internal`        |
| `scheme_upgrade`  | `internal`        |
| `other_subdomain` | `other_subdomain` |
| `external`        | `external`        |

`scheme_upgrade → internal` because a site's own pre-TLS links are not outbound.

The uncomfortable part is that **the duplicate was correct**. Both
implementations agreed. That is what makes it dangerous rather than harmless —
two correct implementations drift on the first edit to either, and nothing would
have failed at the moment they diverged. Grepping for an existing function
before writing one is cheaper than this paragraph.

Taking the scope from the **site** rather than the page turned out to be the
better interface anyway: whether a link is internal is a property of the site
being crawled, not of whichever page happened to contain it.

## Design calls

**Hand-written tolerant scanner, not a DOM parser.** Same choice
`robots/parse.ts` made. A strict parser rejects the malformed markup real sites
serve constantly, and `parse5`/`cheerio` would be the first third-party runtime
dependency in any `packages/*` workspace — a supply-chain decision, not a
parsing one ([ADR-0066](../decisions/ADR-0066-html-link-extraction.md)
alternative A).

**Non-backtracking, because the input is attacker-influenced.** Any site
accepting comments serves attacker-controlled HTML. The scanner walks forward
with an index and never re-scans. A test feeds it 20,000 repetitions of `href=`
inside one tag — the shape that kills a naive regex — and asserts it finishes.

**No raw HTML leaves the module.** The document is an argument, never a return
value, so ADR-0034's storage rule holds by construction rather than by
discipline.

**Facts, not findings.** Nothing here scores or recommends (§5).

## Mutation-tested

60 tests, all green — which is the expected result whether the scanner works or
not, so six of its claims were checked by breaking them:

| Mutation                                      | Result           |
| --------------------------------------------- | ---------------- |
| `script` removed from the opaque-element list | 2 tests failed ✓ |
| comments no longer skipped                    | 2 tests failed ✓ |
| scope switched to a two-label heuristic       | 2 tests failed ✓ |
| `href` entities no longer decoded             | 1 test failed ✓  |
| `<base>` last-wins instead of first-wins      | 1 test failed ✓  |
| link cap removed                              | 1 test failed ✓  |

Restored green at 60 after each.

The `&amp;` case is worth naming: valid HTML _requires_ `&amp;` in a query
string, so `?a=1&amp;b=2` is what a **correct** document contains. Failing to
decode it would make every multi-parameter URL a different URL from the one the
server serves.

## Verification

- `npm run verify:all` — count stated in the session report, not here.
- No migration in this slice: `crawl_links` has existed since 0008.

## Remaining work

1. **Nothing calls the extractor.** This slice is the extractor and its tests.
   Wiring it into `fetchPage`, persisting to `crawl_links` and enqueuing
   discovered internal links into the frontier is the next slice and is **not
   done** — until then a sitemap-less crawl still returns one page. The wiring
   has a known snag: `crawl_links.source_page_id` references `crawl_pages.id`,
   and the current insert in `frontier.ts` uses `onConflictDoNothing` and
   returns only `sitePageId`.
2. **`<a href>` only** — no `<link rel>`, `<area>`, canonical or `<iframe src>`.
3. **No JavaScript rendering.** A client-side-rendered navigation yields nothing.
4. The Stage 7/8 documentation inconsistency above is untouched.
