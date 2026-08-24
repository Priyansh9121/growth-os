# 0056 — The CHECK that could not count

**Date:** 2026-08-24 · **Stage:** 5

## Objective

Build Stage 5's first slice: read `crawl_pages` and `crawl_links` facts, produce
a findings table, and wire one real rule — orphan pages, pages with zero
internal inbound links — that consumes the link graph. Dev log
[0055](0055-the-cap-that-disagreed-with-the-column.md)'s "Remaining work" item 4.

## Initial state

Verified, not recalled: `2bcb821`, `## main...origin/main` with no divergence,
nothing staged, and an uncommitted working tree carrying the contracts, schema,
migration and test file this session continues.

- `.env.local` sourced → `npm test` **2027 passed (2027)**, 67 files
- `npm run verify:all` → exit 0, **32 boundaries**, gitignore clean
- `ls packages/` → **no `packages/seo`**; the audit package did not exist yet
- `ls docs/decisions/` → last ADR **0069**; no 0070, no 0071

## ⚠️ Correction: the ADR the code cited was numbered one too high

The migration, schema, contracts and test file all carried
`@see docs/decisions/ADR-0071-findings-belong-to-a-crawl.md`. Two things were
wrong with that at once.

The file did not exist — AGENTS.md §4 is explicit that a `@see` pointing at a
missing ADR "is worse than no citation: it reads as though the decision was
recorded and reviewed". And the number was not merely unwritten, it was
**wrong**: `ls docs/decisions/` ends at ADR-0069 and nothing had consumed 0070,
so the next free number was 0070 and 0071 would have left a permanent gap.

Renumbered across all four files, and
[ADR-0070](../decisions/ADR-0070-findings-belong-to-a-crawl.md) written before
the commit that cites it.

## ⚠️ The test that passed while proving nothing

`seo-isolation.integration.test.ts` was written but had never been run. Running
it: **13 passed, 1 failed.**

The failure was `shows a workspace only its own findings`, expecting one row and
seeing none. The cause was in the test's own helper:

```ts
await tx.execute(sql`select set_config('app.current_workspace_id', …)`);
```

`app_current_workspace_id()` is the name of the **SQL function** the RLS
policies call (`0001_tenant_row_level_security.sql:45`). The **setting** that
function reads is `app.workspace_id` — `client.ts:168` exports it as
`TENANT_SETTING`, and `agents-isolation.integration.test.ts:186` uses the
correct literal. The helper had confused the two.

**The failing test is not the interesting part.** The test beside it —
`refuses a write stamped with another workspace id` — **passed**, and passed for
entirely the wrong reason. With the setting name wrong, no scope was ever
established; `app_current_workspace_id()` returned `NULL`; and an unscoped
transaction fails closed and refuses _every_ insert. The assertion was
`.rejects.toThrow()`, which cannot tell "RLS refused this cross-tenant write"
from "the transaction was never scoped and refuses everything".

That is precisely the vacuous-green failure mode `assertRestrictedRole` exists
to prevent, arriving through a different door. Two changes, not one:

1. `TENANT_SETTING` is now **imported** rather than retyped, so this file cannot
   get the name wrong on its own.
2. The cross-tenant write asserts **SQLSTATE `42501`** (`insufficient_privilege`
   — a `WITH CHECK` refusal) instead of "it threw". The crawl and page in that
   test belong to workspace B and exist, so a bare throw would have passed just
   as happily for a foreign-key or NOT NULL violation. AGENTS.md §6: the strong
   property, not the weak one.

## Mutation testing

Three constraints carry this table. Each was dropped against
`growth_os_test`, the suite re-run, and the constraint restored.

| Mutation                                         | Result                                 |
| ------------------------------------------------ | -------------------------------------- |
| `DROP INDEX seo_findings_crawl_page_rule_unique` | 1 failed ✓ — the row-bound test, alone |
| `DROP CONSTRAINT …_evidence_is_a_bounded_object` | 3 failed ✓ — every evidence test       |
| `NO FORCE ROW LEVEL SECURITY`                    | 1 failed ✓ — the ENABLE+FORCE census   |

No mutation survived, and none took down a test that did not claim to prove it.
The database was returned to `ENABLE`+`FORCE` with both constraints present and
re-verified green at **14 tests**.

## The four corrections to the brief

The brief for this table was a hypothesis, and four parts of it did not survive
measurement. All four are recorded in
[ADR-0070](../decisions/ADR-0070-findings-belong-to-a-crawl.md); the short form:

**1. "Bound via a CHECK constraint, matching the pattern already used for
`crawl_links`."** Both halves false. A CHECK is evaluated against one row and
**cannot count a table**, so "at most N findings per crawl" is not expressible
as one. And there is no such pattern to match: `crawl_links` has no row cap —
its only CHECK bounds `anchor_text` to 300 characters (0055's finding).

**2. So the bound is a UNIQUE INDEX** on `(crawl_id, site_page_id, rule)`,
mirroring `crawl_pages_crawl_url_unique`. This caps findings _structurally_ —
one row per rule per retrieved page, `crawl_pages` already one row per URL per
crawl, `crawls_budget_is_bounded` already capping `page_limit` at 10,000 — and
is the idempotency guarantee for a re-audit at the same time. No arbitrary
number had to be invented.

**3. "Out of N pages crawled" is corrected to "out of N pages RETRIEVED."**
`crawl_pages` records 404s, 5xx, blocked and failed fetches as rows. A page
cannot be judged orphaned against a denominator that includes pages nobody
successfully read, so the population is `outcome IN ('fetched','unchanged')`.

**4. Self-links are excluded** — not in the brief at all. A page whose only
internal inbound link is from itself is still unreachable from the rest of the
site, and counting it would silently under-report exactly the pages the rule
exists to find.

## Why `evidence` is `jsonb` and not typed columns

`observed` and `population` integer columns were the first design, and they fit
`orphan_page` exactly. They were rejected: they are a lie for the first rule
that decides on a boolean, a string, or three numbers. Generalising a schema
from a sample size of one rule is the over-building §3 forbids.

What a loose column must not become is a nullable bag. `jsonb NOT NULL` alone
accepts `42`, `"orphaned"`, JSON `null`, `[]` and `{}` — all of which satisfy
the column type and none of which states what was measured. The CHECK requiring
a non-empty object under 4 KB is what makes "a finding that decided nothing"
unrepresentable rather than merely discouraged, and it is the half the tests
above prove by refusal.

## Verification — slice (a)

- `npm run verify:all` — exit 0. **2027 passed (2027)**, 67 files.
  **32 boundaries** enforced, gitignore clean.
- Migrations applied **from zero** on a throwaway `growth_os_zero_0070`, which
  then confirmed on a fresh schema: `seo_findings` is `relrowsecurity = t` and
  `relforcerowsecurity = t`; exactly two policies, `polcmd` `r` and `a`, so no
  UPDATE and no DELETE; `seo_findings_evidence_is_a_bounded_object` present;
  all three foreign keys `ON DELETE CASCADE`; the unique index present; and the
  `seo_finding_rule` enum holding exactly `orphan_page`. Database destroyed.

## Slice (b) — the package, and why it is a package

`packages/seo` (`@growth-os/seo`) is new, with exactly two internal
dependencies: `@growth-os/contracts` and `@growth-os/database`.

**The whole argument is that it makes a claim provable.** Inside
`packages/crawler`, "the audit layer cannot fetch a page" would be a comment —
the crawler depends on `@growth-os/net` because it must, and any module inside
it inherits that. As a separate package the same sentence is a lint failure and
a boundary probe. `verify:boundaries` now writes `node:http`, `@growth-os/net`
and `@growth-os/crawler` imports into `packages/seo` and asserts ESLint rejects
each: **35 boundaries**, up from 32.

**`audit` was rejected as a name.** It is already taken by the append-only
compliance trail — `audit.ts`, `audit_events`, ADR-0013 — and a
`packages/audit` holding SEO findings would collide with that in every search
and every conversation. [ADR-0071](../decisions/ADR-0071-the-audit-layer-is-its-own-package.md).

**No `@growth-os/crawler` dependency either**, which is the less obvious half.
The audit reads the crawler's _tables_, not its code. Depending on the package
would restore the network reachability the split just removed, and would couple
what an audit concludes to the implementation that gathered the facts.

The ESLint allowance is written as a **negation** —
`['@growth-os/*', '!@growth-os/contracts', '!@growth-os/database']` — so a
package added later is denied by default rather than silently permitted until
somebody extends a forbidden-list. Both halves were probed rather than assumed:
the denial fails lint, and `contracts` + `database` still pass it.

## ⚠️ The duplication I went looking for, and did not write

Dev log [0054](0054-the-second-classifyscope.md) records a session that wrote a
second `classifyScope` before finding the first, and this rule needs exactly
that kind of logic — it has to decide whether a link points at the page in hand,
and whether it is internal.

It needs none of it. `crawl_links.target_url` was already normalised by the one
`normaliseUrl` before it was recorded (`links/extract.ts:330`), and
`crawl_links.scope` is already the verdict of the one `classifyScope`
(`extract.ts:160`). So the join is a plain text equality and the scope test is
`eq(crawlLinks.scope, 'internal')` — a column read, not a decision.

**`packages/seo` contains no URL code and defines no scope rule**, and that was
checked rather than intended. It is also why ADR-0071 says explicitly that not
depending on `@growth-os/crawler` is not a licence to re-derive it: the two
temptations point in opposite directions and both end at a second normaliser.

## The three predicates that decide "orphan"

"A page nothing links to" sounds unambiguous. Three predicates decide what it
means, and two of them contradicted the brief.
[ADR-0072](../decisions/ADR-0072-the-orphan-page-rule.md).

- **`outcome IN ('fetched','unchanged')`** — the retrieved population. Counting
  every `crawl_pages` row would inflate the denominator _and_ emit an
  `orphan_page` finding for every broken URL the site links to, which is the
  most annoying false positive available: reporting that a page nobody can
  reach is not linked to.
- **`source_page_id <> crawl_pages.id`** — a self-link is not an inbound link.
  Not in the brief. Almost every page links to itself (a logo, a breadcrumb, a
  nav item), so without this the rule rescues precisely the orphans that have a
  site-wide header.
- **`scope = 'internal'`** — read, never recomputed. An orphan is a page _the
  site_ does not link to.

## Chunking: measured, not assumed

The brief suggested following `recordLinks`' chunked writes "if row count could
be large". Measured rather than copied: each finding binds **5** parameters
against PostgreSQL's **65535** ceiling, and `crawls_budget_is_bounded` caps
`page_limit` at **10,000** — so the worst case, every retrieved page orphaned,
is **50,000** parameters. Under the ceiling today, and over it the moment the
row grows a sixth and seventh column. Chunked at 500, for the same reason
`recordLinks` gives: to make the coupling not exist rather than to document it.

## ⚠️ Mutation testing — and one that survived

| Mutation                                | Result                    |
| --------------------------------------- | ------------------------- |
| self-link predicate removed             | 1 failed ✓                |
| outcome filter removed                  | 1 failed ✓                |
| scope filter removed                    | 1 failed ✓                |
| denominator becomes the orphan count    | 4 failed ✓                |
| `ON CONFLICT DO NOTHING` removed        | 1 failed ✓                |
| `isNotNull(site_page_id)` guard removed | **survived** → 1 failed ✓ |

The guard drops an observation the rule cannot name. Every fixture went through
`markFetched`'s shape — and `markFetched` is the only production writer of
`crawl_pages` and always sets `site_page_id` — so the branch was unreachable by
construction, exactly as 0055's retry gate was.

It is still worth having: the column **is** nullable while
`seo_findings.site_page_id` is NOT NULL (ADR-0070), so the row is representable,
and without the guard one malformed observation kills the whole audit with a
23502 instead of being skipped. Closed by inserting such a row directly and
asserting it is dropped from the findings _and_ from the population. Re-running
the mutation then failed the new test.

## Verification — slice (b)

- `npm run verify:all` — exit 0. **2050 passed (2050)**, 69 files.
  **35 boundaries** enforced (32 before), gitignore clean.
- `npm run verify:e2e` — **77 passed**. Not skipped: this slice touches no `apps/web`, `packages/ui`, token or route file — confirmed by `git status --short`, which lists only `docs/`, `eslint.config.mjs`, `scripts/verify-boundaries.mjs`, `package-lock.json` and `packages/seo/` — but the gate fails rather than skips, so it ran.
- Migrations re-applied **from zero** on a throwaway database at the final tree
  and destroyed; no migration in this slice.

## Remaining work

1. **Nothing calls `recordOrphanPages`.** It takes a transaction and a crawl id
   and has no production caller. When an audit runs — at the end of a crawl, on
   demand, or on a schedule — is a separate decision that ADR-0071 explicitly
   does not make.
2. **One rule.** `SEO_FINDING_RULES` has a single member because a member with
   no rule behind it is a value the enum accepts and nothing explains.
3. **No severity, prioritisation or UI**, all out of scope by the brief and by
   ADR-0070's decision D.
4. Recorded, not fixed, and still true from
   [0055](0055-the-cap-that-disagreed-with-the-column.md): `PROJECT-STATUS.md`
   says the crawler has no caller; `ai-agent-architecture.md:3` and `:162` call
   the agent runtime "Stage 7" while the roadmap makes Stage 8 the agent;
   `links/extract.ts:15` cites ADR-0034 for a rule ADR-0034 does not contain.
   Newly noticed: the roadmap's **Stage 5 lists "Dependencies: Stage 3"**, which
   is stale — this stage reads `crawl_pages` and `crawl_links`, both Stage 4.
