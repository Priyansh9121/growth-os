# 0023 — One migration, three findings, and the first live §7.2

**Date:** 2026-08-18 · **Stage:** 4

## Objective

One migration closing the three things that had accumulated behind it: the
missing `crawl_frontier` length CHECK (ADR-0038), and the two skip reasons
`crawl_skip_reason` could not express — `url_too_long` (ADR-0038) and
`budget_exhausted` (ADR-0039).

## Initial state

Verified, not recalled: `44a5aec`, tree clean, `verify:all` exit 0 at **948
passed / 208 skipped (1156)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## ⚠️ The first thing measured was whether §7.2 could run at all

Every brief for several sessions has carried "migrations apply from zero on a
throwaway database" as a vacuous condition, because no migration was touched.
This one is live, so the first question was whether there is a database.

There is: **PostgreSQL 18.4** on `127.0.0.1:55432`. `verify:all` cannot reach it
— the integration project skips itself when `TEST_DATABASE_URL` is unset, which
is why 208 tests skip — but it is there and §7.2 is genuinely runnable.

## Investigation

### The enum semantics, measured rather than assumed

The brief flagged that `ALTER TYPE … ADD VALUE` is not reversible in a
transaction on older versions. On this server:

| operation                                     | result                                                         |
| --------------------------------------------- | -------------------------------------------------------------- |
| `ALTER TYPE … ADD VALUE` inside a transaction | **works** (PostgreSQL 12+)                                     |
| **using** that value in the same transaction  | **`ERROR: unsafe use of new value "d" of enum type t`**        |
| `ADD VALUE IF NOT EXISTS`, re-run             | idempotent — `NOTICE: enum label "c" already exists, skipping` |

The second row is the one that shapes the migration. The runner wraps each file
in a transaction, and the error rolls the whole thing back — so the migration
adds both values and **never uses them**: no `INSERT`, no comparison, no `CHECK`
mentioning them. A file that seeded a row with `url_too_long` would have taken
the schema change down with it.

### ⚠️ Whether the CHECK could reject existing rows — a stronger answer than expected

The brief asked for this to be verified. It is not "there happen to be no rows":

**The crawl tables do not exist in the only database on this machine.** The local
database is at migration 0007 — eight migrations recorded, `sites` present,
`crawl_frontier` / `crawl_pages` / `site_pages` absent. Migration 0008 has never
been applied there.

```
ERROR:  relation "crawl_frontier" does not exist
```

Verified on the throwaway after applying from zero: all three tables at **0
rows**. So the constraint cannot reject anything, anywhere — and that is the last
moment that will be true, which is the same argument that made ADR-0041 urgent.

## The one design decision

`budget_exhausted` was two lines: `isAllowed` already returned the precise
reason and `decide.ts` simply threw it away.

`url_too_long` was not. `normaliseUrl` returns `null` for a `mailto:`, a `tel:`,
a bare `#fragment`, an unparseable string **and** an over-length URL, so
`decide.ts` could not tell them apart — which is precisely why all of them became
`unsupported_scheme`.

Re-deriving "was it too long?" in `decide.ts` would mean duplicating the ceiling
check, and there are **two** of them: before any work, and again after
normalising, because normalising can grow a URL (`+` → `%20`, 2.98× in
ADR-0038). §5 makes URL identity singular, and a second partial opinion about it
is the failure that invariant exists to prevent.

So: **one implementation, two entry points.** `normaliseUrlOutcome` is the
implementation and returns `{ url, refusal }`; `normaliseUrl` is now a one-line
wrapper over it. Every existing caller is untouched, and there is still exactly
one normaliser.

The refusal is `'not_a_resource' | 'too_long'`, not a `SkipReason` — the URL
layer should not know what the frontier calls things. `decide.ts` maps one to the
other, which is where that vocabulary belongs.

## ⚠️ The tests proved the weak property first

The three constraint tests insert as the **owner**, past every application
check, and originally asserted `rejects.toThrow(/crawl_frontier_url_is_bounded/)`.

They failed — not because the row was accepted, but because Drizzle wraps the
driver error and the constraint name is not in `message`:

```
expected [Function] to throw error matching /crawl_frontier_url_is_bounded/
but got 'Failed query: insert into "crawl_frontier" …'
```

The row **was** refused. The assertion just could not see why, which means it
would have passed for a typo, a missing column or a null violation — "an error
was returned" rather than "the row was refused by that constraint" (§6).

Measured the error shape: the driver error hangs off `cause`, carrying
`constraint_name` and SQLSTATE. The tests now assert the pair:

```ts
{ code: '23514', constraint: 'crawl_frontier_url_is_bounded' }
```

`23514` is `check_violation`. An unknown enum value is asserted separately as
`22P02` — refused at the type, before any constraint runs. And the three tables
are asserted to carry the **same** predicate, read from `pg_constraint` rather
than from the migration text, because three copies of one number is how they stop
agreeing.

## Result

Migration `0009_frontier_url_check_and_skip_reasons.sql` — one CHECK, two enum
values, nothing used.

**§7.2, run twice** — once mid-development and once against the final tree, each
on a freshly created database:

```
Applying migrations from …/packages/database/migrations
Migrations applied.
```

10 migrations recorded; `enum_range` returns all eleven skip reasons;
`crawl_frontier_url_is_bounded` present in `pg_constraint`; the migrator re-run
against the same database applied cleanly. **The throwaway was dropped and no
`gos_*probe*` database remains.**

## Testing

`verify:all` exit 0: **957 passed / 215 skipped (1172)**, against 948 / 208
(1156) at the start. 29 boundary probes.

With `TEST_DATABASE_URL` set, the integration project runs **215 passed** — the
208 that skip without a database, plus the 7 added here. That is the first time
this session's work has been measured against the whole integration suite rather
than a skipped one, and nothing else broke.

Four unit tests in `decide.test.ts` were observed red before the wiring, with the
right messages: `expected 'unsupported_scheme' to be 'url_too_long'` and
`expected 'robots_disallowed' to be 'budget_exhausted'`.

One test asserts the two lists cannot drift: every value in `SKIP_REASONS` is in
the database enum and the sizes match, so a reason `decide.ts` can emit but the
column cannot hold would fail here rather than at crawl time.

## Files

```
packages/database/migrations/0009_frontier_url_check_and_skip_reasons.sql
packages/database/migrations/meta/_journal.json      idx 9
packages/contracts/src/crawl/enums.ts                two SKIP_REASONS + labels
packages/crawler/src/urls/normalise.ts               normaliseUrlOutcome; normaliseUrl wraps it
packages/crawler/src/frontier/decide.ts              emits both new reasons
packages/crawler/src/frontier/decide.test.ts         9 unit tests
packages/crawler/src/frontier/frontier.integration.test.ts   7 integration tests
docs/decisions/ADR-0042-frontier-bound-and-precise-skip-reasons.md
docs/development-log/0023-one-migration-three-findings.md
docs/decisions/README.md, docs/development-log/README.md     index rows
```

## Remaining work

Dev log 0018's ranked list. Items 1–4 and the migration are now closed; **nothing
that remains is an identity, permission or denial-of-service defect.**

1. `neutraliseCsvFormula` is documented in `docs/security/data-lifecycle.md` as
   the live control for formula injection on export, and has no callers — there
   is no CSV export. Fix the document now, or wire it when an export exists. A
   security document that says a problem is solved is worse than silence.
2. `fieldTarget` (`contracts/forms/schemas.ts`) has no `.max()` and accepts a
   200 KB value into stored config.
3. Four `/^https?:\/\//i` copies disagree about the same question — one
   normaliser, or four documented behaviours.
4. The CRM LIKE escaper misses `\`, which affects `countTracesOf`, the helper the
   integration suite uses to prove GDPR erasure. A verification helper that
   under-reports fails in the direction that looks green.
5. `verification.ts` inherits an 8 MB body cap where its comment says 1 MB.
6. The client-side email regex, as a length guard.

⚠️ Also open, and not from 0018: the local development database is at migration 0007. Nothing has applied 0008 or 0009 to it. That is fine while the crawler has
no production path, and it means the crawl schema has only ever existed inside a
test harness.
