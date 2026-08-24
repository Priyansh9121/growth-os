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
