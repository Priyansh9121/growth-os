# 0051 — The run gets a table

**Date:** 2026-08-23 · **Stage:** 7 (Phase 0)

## Objective

Give the agent platform its five tables — `campaigns`, `agent_runs`,
`agent_outputs`, `approvals`, `attribution_events` — with the provenance rule
enforced by PostgreSQL rather than by code that does not exist yet.

## Initial state

Verified, not recalled: `09908ae`, tree clean, `## main...origin/main` in sync.
`npm run verify:all` green at **1818 passed / 0 skipped (58 files)** with
`TEST_DATABASE_URL` set. PostgreSQL on **55432** (`~/.growth-os/pgdata`, PID
11424), identified by data directory per [0045](0045-a-preflight-that-lied.md).

Migration journal in sync: 14 entries, idx 0–13, matching 14 `.sql` files, so
0014 was the next tag. Snapshots stop at `0008_snapshot.json` — 0009 onward are
hand-written, which is the convention this migration follows.

## `ToolContext.runId` had no other end

The thing that made the shape obvious. `contracts/src/ai/tool.ts:78` has
required a `runId` on every tool call since long before this work, describing it
as correlating every call in one run _"for tracing and audit"_ — a foreign key
pointing at nothing. `ai-agent-architecture.md:170` lists **"Run traces: every
tool call, argument, result and cost, per `runId`"** among what Stage 7 adds.

`agent_runs.id` is that table. Nothing needed inventing; the contract had
already specified the join and left it dangling.

## What the database refuses

Nine CHECK constraints, one trigger, and the one NOT NULL the model exists for.
All verified by probing `pg_constraint` and `pg_class` on a throwaway database
rather than by reading the SQL back:

- `agent_outputs.agent_run_id` **NOT NULL** — an output that cannot name its
  run is an unattributed claim about what an AI decided.
- `agent_outputs.autonomy_level` **BETWEEN 1 AND 4** — contracts'
  `AutonomyLevel`, not a second vocabulary. Phase 0 writes 2 to every row.
- `approvals` — `edit_diff` present **if and only if** `decision = 'edited'`,
  written as one equality so both directions fail: an `edited` row with no diff,
  and a diff on a plain `approved`.
- `agent_runs` — completion time and status agree in both directions, and a
  failure reason requires an actual failure.
- `attribution_events` — the outcome decides which of the three target columns
  is set, and a trigger refuses an output that was never published.

### ⚠️ `ELSE false` was the subtle one

The attribution target constraint is a `CASE` over the outcome enum. Written
without a terminal `ELSE`, a newly added enum value falls through to `NULL` —
and **a CHECK constraint that evaluates to NULL passes in PostgreSQL.** The
constraint would have silently stopped applying at exactly the moment someone
extended the enum, which is the moment it matters most. `ELSE false` turns that
into a loud failure in the migration that adds the value.

## The tests were mutation-tested, because passing proves nothing on its own

24 tests, all green — but green is the expected result whether the constraints
work or not, so three were checked by breaking the thing they test:

| Mutation                                      | Result                              |
| --------------------------------------------- | ----------------------------------- |
| `ALTER TABLE agent_outputs … DROP NOT NULL`   | 2 provenance tests failed ✓         |
| `ALTER TABLE agent_runs NO FORCE ROW LEVEL …` | the ENABLE+FORCE test failed ✓      |
| `DROP TRIGGER … output_must_be_published`     | the unpublished-draft test failed ✓ |

Each was then restored, and the test database was finally dropped and rebuilt
from zero so no hand-patched state survived into the reported result.

The provenance test inserts through **raw SQL, not Drizzle**, deliberately.
Drizzle's types already make a NULL `agent_run_id` unwriteable in TypeScript, so
a test going through the ORM would prove the type system works and say nothing
about the row a psql session, a future migration, or a service in another
language could write. §6 asks for the strong property.

A positive test sits beside the refusals — a coherent attribution row is
accepted and joins back to its contact through RLS. Without it, a constraint
that rejected _everything_ would look identical to a healthy one.

## What was NOT built, and why

- **`channel_credentials`.** Measured rather than assumed: `grep` for
  `createCipheriv`, `createDecipheriv`, `aes-256`, `encrypt(` and `decrypt(`
  across `packages/` and `apps/` returns **nothing**. Every secret here is
  one-way HMAC or hash. Building a credential store would have meant inventing
  a secrets pattern as a side effect of a schema task, with no connector to
  validate it against. Deferred to the connector phase
  ([ADR-0063](../decisions/ADR-0063-agent-platform-data-model.md) alternative
  B), and a test asserts the table does not exist so the deferral cannot lapse
  quietly.
- **Channel columns on `attribution_events`.** A test enumerates
  `information_schema.columns` and fails if `utm_*`, `source_type`,
  `confidence`, `landing_path` or `channel_detail` ever appear — the failure it
  guards against is a later migration "helpfully" denormalising provenance that
  [ADR-0012](../decisions/ADR-0012-provenance-model.md) already owns.
- **Any auto-approve path.** `autonomy_level` is a column, not a behaviour.

## Design calls worth recording

**`approvals` is append-only and NOT unique per output.** A decision that can be
`UPDATE`d is not an audit record — the same reasoning that makes `activities`
append-only in 0003. Re-deciding appends; the current decision is the latest
`decided_at`. A UNIQUE constraint can be added later if re-deciding proves
wrong, which is easier than removing one a workflow needs.

**`campaigns.ends_at` is nullable.** The brief called a campaign "time-boxed"
and most are, but an always-on nurture campaign is real, and a fictional end
date would make every query filtering on it wrong. The CHECK constrains ordering
only when an end is declared.

**The publish trigger is deliberately not `SECURITY DEFINER`.** It runs with the
caller's privileges, so an output in another workspace is invisible to its
lookup and the insert fails closed — the correct answer to a cross-tenant
attribution attempt.

## Verification

- `npm run verify:all` — **1842 passed (1842)**, 59 files. The 24 new tests are
  the entire delta from 1818.
- Migrations applied from zero on `growth_os_throwaway_0014`, constraints and
  RLS probed there directly, then the database was destroyed.
- All five tables confirmed `relrowsecurity` **and** `relforcerowsecurity` true.

## Remaining work

1. **The guardrails package** — the self-duplication check. Not started.
2. **No writer exists.** Every table here is shaped by reasoning about what will
   write it, which is weaker evidence than a caller. The first service to use
   them is the real test of the design.
3. **`attribution_events` has no consumer.** Built to be queried; the first
   report may well need a migration.
