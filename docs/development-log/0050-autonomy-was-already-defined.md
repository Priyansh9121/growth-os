# 0050 — Autonomy was already defined

**Date:** 2026-08-22 · **Stage:** 7 (Phase 0)

## ⚠️ Written after the fact, and that is a contract failure worth recording

AGENTS.md §4 requires the dev log entry in the same slice as the work it
describes, and the ADR in the same commit as the code that cites it. The
contracts slice shipped with **neither**. This entry and
[ADR-0063](../decisions/ADR-0063-agent-platform-data-model.md) were written in a
later session and folded into that commit by amend, which was possible only
because it had not been pushed.

§4 says a log written later is written from commit messages rather than from
memory of the reasoning. That applies here and the reader should discount
accordingly: the _decisions_ below are recoverable from the code and its
comments, the deliberation that produced them is not.

## Objective

Phase 0 of the multi-agent marketing platform: give the platform its closed
value sets, before any table or agent exists to use them.

## Initial state

Verified, not recalled: `d1bff9e`, tree clean, `## main...origin/main
[ahead 1]` — the slice was committed but **not pushed**, which the handoff into
this session had reported as landed.

`npm test` exit 0 at **1497 passed / 321 skipped (1818)**.

⚠️ **That skip count is the no-database state, not the suite.** The 321 are
integration tests gated on `TEST_DATABASE_URL` via `hasTestDatabase()`. With
`.env.local` sourced the same command returns **1818 passed / 0 skipped across
58 files**. Both numbers are honest; only the second is a baseline for work that
touches the database tier, and the RLS tests the next slice needs are inside the
gated set. Prior entries have quoted the 321 figure without this caveat.

PostgreSQL on **55432** (`~/.growth-os/pgdata`, PID 11424) — identified by data
directory, per [0045](0045-a-preflight-that-lied.md). A second cluster was again
listening on 55433 and is not this project's.

## What the slice decided

Three value sets in `packages/contracts/src/agents/enums.ts`:

- `AGENT_RUN_STATUSES` — `running`, `completed`, `failed`. Deliberately no
  `cancelled`: nothing can cancel a run yet, and a status nothing can produce is
  a case every query must handle for no reason.
- `APPROVAL_DECISIONS` — `approved`, `rejected`, `edited`. `edited` is separate
  from `approved` because "approved as written" and "had to be rewritten first"
  are different facts about the agent that produced the draft.
- `ATTRIBUTION_OUTCOMES` — five CRM outcomes, as a native enum rather than text.
  The trade is stated in the file: `ActivityType` is text because it grows with
  every feature; this set is small, closed, and is what a revenue report groups
  by, so a new value should cost a migration.

## The part that mattered: a fourth enum was proposed and rejected

The Phase 0 brief asked for a new three-tier autonomy enum on agent outputs.
It was not built. `AutonomyLevel` already exists in `ai/tool.ts` with four
levels and is enforced inside `invokeTool`'s guard chain.

The reasoning is recorded in full as
[ADR-0063](../decisions/ADR-0063-agent-platform-data-model.md) alternative A.
The short version: two vocabularies for "may an AI do this without asking?"
cannot both be authoritative, and the one the guard chain does not read is the
one that drifts. Same class as §5's _"URL identity is singular"_.

It is held open by a test rather than by a comment — `enums.test.ts` enumerates
the module's exports and fails if any name matches `/autonom|tier/i`. A second
autonomy vocabulary cannot be added to this module quietly.

## ⚠️ The committed comments named the wrong guard-chain step

Both `enums.ts` and `enums.test.ts` said autonomy is enforced as **step 3** of
`invokeTool`'s guard chain. Checked against the source rather than carried
forward — `registry.ts:9-14` lists six steps, and autonomy is **step 4**:

```
1. the tool exists
2. arguments parse against the tool's schema
3. the acting user holds the required capability   <- capability, not autonomy
4. the workspace's autonomy level permits the tool
5. the run has budget remaining
6. the result parses against the tool's output schema
```

Step 3 is the capability check. `registry.ts:16-19` makes the separation
explicit — capability answers "may this person do this at all?", autonomy
answers "may an AI do it without asking?" — so citing the wrong one inverts the
distinction the comment exists to explain. Corrected in both files in the amend.

Small, but it is the second time in this repository that a number was carried
between files rather than re-derived ([0049](0049-the-carrier-not-the-palette.md)
found a stale 0.005 the same way). Re-deriving is cheap.

## What did not change

`ai/tool.ts` and `ai/registry.ts` were not touched. The agents module adds
vocabulary; it takes nothing over.

## Remaining work

1. **The schema.** `campaigns`, `agent_runs`, `agent_outputs`, `approvals`,
   `attribution_events` — migration 0014, the journal verified in sync at 14
   entries. `agent_outputs.agent_run_id` must be `NOT NULL` at the database and
   proven by a test asserting the row is **refused**, per §6.
2. **RLS on all five**, `ENABLE` + `FORCE` per §5, proven by an integration test
   connecting as the restricted role — inside the gated 321, so it must be run
   with `TEST_DATABASE_URL` set.
3. **`channel_credentials` stays deferred** to the connector phase. Measured
   this session: no reversible-encryption primitive exists anywhere in
   `packages/` or `apps/` — only one-way HMAC and hash. ADR-0063 alternative B.
