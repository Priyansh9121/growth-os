# ADR-0042 — The frontier's URL bound, and two skip reasons the enum could not express

**Status:** Accepted
**Date:** 2026-08-18

## Context

Three things were recorded, deliberately deferred, and each named at the time as
belonging with the others because each needed a migration and none justified one
alone. They are three symptoms of the same gap: **the database not backing up
what the application had already decided.**

### 1. `crawl_frontier.normalised_url` had no bound

ADR-0038 verified it and recorded it rather than fixing it. `crawl_pages` and
`site_pages` have both carried
`CHECK ("normalised_url" <> '' AND length("normalised_url") <= 2048)` since
migration 0008. `crawl_frontier.normalised_url` was a bare `text NOT NULL`.

⚠️ **And `enqueueDiscovered` writes to `crawl_frontier`** — so the one table on
the write path was the one with no backstop. AGENTS.md §5 says limits live in the
database; here the application check was doing that work alone.

### 2. `url_too_long` — ADR-0038

An over-length URL was recorded as `unsupported_scheme`, which is the label
**every** `normaliseUrl → null` received. It says "this is a `mailto:`" about an
ordinary page whose only problem is length. The scheme is the site's; the ceiling
is ours.

### 3. `budget_exhausted` — ADR-0039

A URL refused because the robots matcher's step budget ran out was recorded as
`robots_disallowed`, which asserts that a rule the site owner wrote decided it.
It did not; our budget did, and we refused rather than guess whether any rule
matched. The `RobotsVerdict` has carried the distinction since ADR-0039; the
frontier row could not express it.

⚠️ That is a §5 facts-vs-findings failure in the direction that matters — the row
did not merely lose precision, it **attributed our limit to the customer's
file**.

## ⚠️ What the enum change actually does, measured

The brief asked for this rather than assumed, because `ALTER TYPE ... ADD VALUE`
has a version-dependent history. Measured on this server, **PostgreSQL 18.4**:

| operation                                     | result                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| `ALTER TYPE … ADD VALUE` inside a transaction | **works** (PostgreSQL 12+ relaxed the old restriction)          |
| **using** that value in the same transaction  | **`ERROR: unsafe use of new value`** — the whole txn rolls back |
| `ADD VALUE IF NOT EXISTS`, re-run             | **idempotent** — NOTICE, skip                                   |

The migration runner wraps each file in a transaction. So **migration 0009 adds
the two values and never uses them**: no `INSERT`, no comparison, no `CHECK`
mentioning them. A migration that seeded a row with `url_too_long` would fail and
take the schema change down with it.

Before PostgreSQL 12 the `ADD VALUE` itself could not run in a transaction at
all. That is not this server, and `engines` pins Node rather than PostgreSQL, so
`IF NOT EXISTS` is there to keep the file re-runnable rather than to work around
a version.

## ⚠️ Whether the CHECK could reject existing rows — the finding

The brief flagged this as a risk. Verified rather than assumed, and the answer is
more absolute than expected:

**The crawl tables do not exist in the only database on this machine.** The local
development database is at migration 0007 — eight migrations recorded, `sites`
present, and no `crawl_frontier`, `crawl_pages` or `site_pages` at all. Migration
0008 has never been applied there.

So the constraint cannot reject existing rows, because there are none anywhere,
because the tables have never been created outside a test harness. Verified on
the throwaway after applying from zero: `crawl_frontier`, `crawl_pages` and
`site_pages` all at **0 rows**.

⚠️ **This is the last moment that is true.** The same argument that made ADR-0041
urgent applies here: a bound added before there is data is a constraint; added
after, it is a migration plus a backfill plus a decision about what to do with
rows that violate it.

## Decision

**One migration, `0009_frontier_url_check_and_skip_reasons.sql`, doing three
things and using none of them.**

1. `ALTER TABLE crawl_frontier ADD CONSTRAINT crawl_frontier_url_is_bounded
CHECK ("normalised_url" <> '' AND length("normalised_url") <= 2048)` — the
   same predicate, spelled the same way, as the two tables that already had it.
2. `ALTER TYPE crawl_skip_reason ADD VALUE IF NOT EXISTS 'url_too_long'`
3. `ALTER TYPE crawl_skip_reason ADD VALUE IF NOT EXISTS 'budget_exhausted'`

### And `decide.ts` emits both

⚠️ **A migration that adds a value nothing emits is a schema change pretending to
be a fix.** Both reasons are wired, and both are asserted at the decision layer
and at the database.

`budget_exhausted` was a two-line change — `isAllowed` already returned the
precise reason. `url_too_long` was not, and it is the one design decision here.

### ⚠️ `normaliseUrl` had to say _why_ it returned `null`

`normaliseUrl` returns `null` for a `mailto:`, a `tel:`, a bare `#fragment`, an
unparseable string, **and** an over-length URL. `decide.ts` could not tell them
apart, which is exactly why they all became `unsupported_scheme`.

The ceiling is also checked **twice** — before any work and again after
normalising, because normalising can grow a URL (`+` → `%20`, measured at 2.98×
in ADR-0038). So re-deriving "was it too long?" in `decide.ts` would mean
duplicating both checks, and §5 forbids a second opinion about URL identity.

**One implementation, two entry points:**

```ts
export function normaliseUrlOutcome(input, options): NormaliseOutcome; // the implementation
export function normaliseUrl(input, options): string | null; // one-line wrapper
```

`normaliseUrl` is now `normaliseUrlOutcome(...).url`. There is still exactly one
normaliser — §5 makes identity singular, and two implementations that drift is
the failure that invariant exists to prevent. Every existing caller is untouched.

The refusal is `'not_a_resource' | 'too_long'` rather than a `SkipReason`,
because the URL layer should not know what the frontier calls things. `decide.ts`
maps one to the other, which is where that vocabulary belongs.

## Verification

⚠️ **§7.2 is live for this brief, and `verify:all` cannot run it.**

Applied from zero on a throwaway PostgreSQL 18.4 database, twice — once
mid-development and once against the final tree:

```
Applying migrations from …/packages/database/migrations
Migrations applied.
```

**10 migrations recorded.** `enum_range(NULL::crawl_skip_reason)` returns all
eleven values including both new ones; `crawl_frontier_url_is_bounded` is present
in `pg_constraint`. The migrator was re-run against the same database and applied
cleanly, so the file is idempotent in practice and not only in theory. **The
throwaway was then dropped, and no `gos_*probe*` database remains.**

### The constraint is proven by a row the database refuses

§5: the test for a constraint is a row that must be _refused_. Three integration
tests insert as the **owner**, straight past every application check.

⚠️ **"It threw" is the weak property, and the first version of these tests only
proved that.** Drizzle wraps the driver error, so the constraint name is not in
`message` — the assertion would have passed for a typo, a missing column or a
null violation. Measured, the driver error hangs off `cause`, so the tests now
assert the pair:

```
{ code: '23514', constraint: 'crawl_frontier_url_is_bounded' }
```

`23514` is `check_violation`. An unknown enum value is asserted separately as
`22P02` (`invalid_text_representation`) — refused at the type, before any
constraint runs.

And the three tables are asserted to carry the **same** bound, read from
`pg_constraint` rather than from the migration text, because three copies of one
number is how they stop agreeing.

### Counts

`verify:all` exit 0: **957 passed / 215 skipped (1172)**, against 948 / 208
(1156) before. 29 boundary probes.

With `TEST_DATABASE_URL` set, the integration project runs **215 passed** — the
208 that skip without a database, plus the 7 added here. Four unit tests in
`decide.test.ts` were observed red before the wiring.

## Alternatives considered

**Re-check the length in `decide.ts` instead of changing `normaliseUrl`.**
Rejected by §5. The ceiling is enforced twice inside `normaliseUrl`, once on the
input and once on the grown output, so a caller-side check would be a second,
partial opinion about identity — and the one that silently disagrees is always
the copy.

**A separate `isTooLong()` helper.** Same defect with an extra function: it
cannot see the post-normalisation growth without normalising again.

**Change `normaliseUrl` to return the outcome directly.** Rejected as needless
churn — it has many callers that do not care, and a wrapper costs one line and
zero divergence.

**Three migrations, one per finding.** Rejected: each was deferred _because_ it
needed a migration, and three files that must be applied together are three
chances to apply two.

**Add the enum values with a type rewrite** (`CREATE TYPE … new`, `ALTER TABLE …
USING`, `DROP TYPE`), which is what Drizzle Kit generates. Rejected — it is what
`ADD VALUE` exists to avoid, it rewrites the column, and it would have to drop
and recreate the `crawl_frontier_skip_reason_matches_state` constraint that
depends on the type.

**Backfill existing rows recorded under the imprecise reasons.** There are none;
see the finding above.

## Consequences

### Positive

- All three tables on the URL write path carry the same bound, proven from the
  catalogue.
- An operator seeing "we did not crawl this" is told whether it was their rule,
  our ceiling, or our budget — three different facts that were previously two
  labels.
- The migration is idempotent and safe to re-run, verified by running it twice.

### Negative

- `crawl_skip_reason` now has eleven values and any exhaustive `switch` over it
  must handle two more. `SKIP_REASON_LABELS` is `Record<SkipReason, string>`, so
  a missing label is a type error rather than a runtime gap — and a test asserts
  every reason has one.
- Enum values cannot be removed in PostgreSQL. If either name turns out wrong it
  is a type rewrite to change, which is a real cost of spending the migration
  now rather than later.
- `packages/crawler` gains a second exported entry point into normalisation. It
  is a wrapper over the same code, but it is one more name a future author must
  choose between.

## Related

- [ADR-0038](ADR-0038-url-length-ceiling.md) — recorded findings 1 and 2 without fixing them
- [ADR-0039](ADR-0039-robots-matcher-step-budget.md) — recorded finding 3
- [ADR-0036](ADR-0036-frontier-budget-and-ceiling.md) — the frontier and its row ceiling
- [dev log 0023](../development-log/0023-one-migration-three-findings.md) — this work
