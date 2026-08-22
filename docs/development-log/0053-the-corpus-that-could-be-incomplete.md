# 0053 — The corpus that could be incomplete

**Date:** 2026-08-23 · **Stage:** 7 (Phase 0)

## Objective

Give `evaluateGuardrails` a real caller. Until now nothing in the repository
called it — it was shaped by reasoning about a caller rather than by one.

## Initial state

Verified, not recalled: `aa6a1a5`, tree clean, `## main...origin/main` in sync.

Both suite states, because only one is a baseline for work touching the
database tier:

- `env -u TEST_DATABASE_URL npm test` → **1557 passed / 345 skipped (1902)**
- `.env.local` sourced → **1902 passed (1902)**, 62 files

PostgreSQL by **`-D` data directory**, not by which port answered
([0045](0045-a-preflight-that-lied.md)): `55432` → `~/.growth-os/pgdata`
(PID 11424). `55433` → `~/Desktop/AI`, unrelated.

## Two open questions the brief flagged — both answered by looking, not guessing

**The capability already existed.** The brief asked whether a
`workspace:agent_outputs:*` capability was needed.
`contracts/src/tenancy/capabilities.ts` already defines `workspace:ai:query`,
`workspace:ai:approve_action` and `workspace:ai:configure_autonomy`, and
`workspace:ai:query` is granted to `member`, `admin` and `owner` through the
spread chain but **not** `viewer` — exactly the shape this service needs.

Adding `workspace:agent_outputs:read` would have been a second vocabulary for
"may this actor use the AI surface", which is the call ADR-0063 already made
about autonomy. Reused instead. Because no capability was added, §5's "every
new capability ships with a grant test" does not fire.

**The corpus window was measured before being decided.** The brief said how much
history counts as "priors" was undecided and should not be guessed. Benchmarking
`evaluateGuardrails` against ~250-word drafts:

| Priors |      Total | Per prior |
| -----: | ---------: | --------: |
|     10 |     0.6 ms |  0.061 ms |
|    100 |     4.9 ms |  0.049 ms |
|  1,000 |    45.4 ms |  0.045 ms |
| 10,000 |   448.0 ms |  0.045 ms |
| 25,000 | 1,129.0 ms |  0.045 ms |

Cleanly linear at ~0.045 ms per prior. A workspace publishing five pieces a week
accumulates ~260 a year, so comparison is tens of milliseconds.

**That is a negative result and it is the useful part: cost does not decide the
window.** The comparison is cheap; the `jsonb` fetch is what bounds it. So no
number was chosen — `priorLimit` is a required parameter with no default, and
the service reports when the limit bound the answer.

## The actual contribution: an incomplete corpus can no longer produce a pass

[ADR-0064](../decisions/ADR-0064-self-duplication-guardrail.md) recorded a risk
it could not enforce: _"nothing stops a caller passing an incomplete corpus, and
a check that compares against nothing returns `pass`"_. Guardrails is pure, so
it cannot know what it was not given.

This service can. It counts published outputs **before** fetching, and when the
count exceeds the limit, a `pass` becomes `indeterminate` with a finding naming
both numbers. That is the same honesty the word-count floor already applies
inside the check — say what you do not know rather than folding it into a pass.

⚠️ **`fail` is never touched.** Truncation can only hide matches, never invent
one, so a duplicate found against a partial corpus is still a duplicate. A test
pins that a truncated `fail` carries no completeness caveat.

⚠️ **Truncation is counted, not inferred.** `rows.length === limit` cannot
distinguish "exactly the limit" from "more than the limit", and the natural fix
trades a false alarm for a false clearance. The off-by-one is pinned by a test
asserting limit 4 truncates and limit 5 does not, against exactly 5 priors.

## ⚠️ A mutation that survived, and what it actually means

Five mutations, four caught:

| Mutation                                            | Result                   |
| --------------------------------------------------- | ------------------------ |
| truncation downgrade removed                        | 2 tests failed ✓         |
| downgrade widened to `fail` as well                 | 2 tests failed ✓         |
| `requireCapability` removed                         | 2 tests failed ✓         |
| `publishedAt` filter dropped                        | 1 test failed ✓          |
| **`workspace_id` predicate dropped from the query** | **16 passed — survived** |

The predicate is redundant. `agent_outputs` is `RLS ENABLE` + `FORCE`, and the
restricted role cannot see another tenant's rows with or without it — including
as the table owner, since FORCE closes that exemption too.

It is kept, because it is the same defence-in-depth the CRM applies and removing
it would make this the one service that trusts a single mechanism. But the
honest reading is recorded in the ADR: **the isolation test proves RLS, not the
predicate**, and no test in this suite can tell them apart. A later reader
should not mistake a green isolation test for evidence the predicate does work.

This is the value of mutation testing being reported rather than only run — a
surviving mutation is a finding about what the tests mean.

## Two things fixed in review before commit

A placeholder test asserting `expect(true).toBe(true)` was written and then
replaced with the real off-by-one boundary case it was standing in for. A test
that asserts `true` passes forever and proves nothing, which is worse than no
test because it occupies the space where the real one would go.

The test fixture reached into `harness.owner._.fullSchema` for the `workspaces`
and `users` tables. Replaced with proper imports from
`@growth-os/database/schema` — a test coupled to a driver's internals breaks on
an upgrade that changes nothing about the code under test.

## Design calls worth recording

**A new `@growth-os/agents` package**, not a folder in `crm`. The CRM owns
contacts, deals and provenance; agent runs are a different domain that merely
joins to it. Its context mirrors `forms`, which mirrors `crm` — same
transaction, same capability check, same errors. Two security models is how one
of them ends up weaker.

**The proposed output need not exist in the database.** A test asserts the row
count is unchanged across a check. This is the whole payoff of ADR-0064's purity
decision: the check runs before the row is written, which is when catching a
duplicate is still cheap.

Boundaries: an ESLint block restricts `agents` to contracts, database and
guardrails, with an `agents → ui` probe. **32 enforced, up from 31.**

## Verification

- `npm run verify:all` — count stated in the session report, not here.
- `npm run verify:boundaries` — 32, including the new probe.
- `package-lock.json` updated by `npm install` to register the workspace; the
  diff adds `packages/agents` and its three internal dependencies, nothing else.

## Remaining work

1. **Still no production caller.** This is one layer closer to reality than
   0052 was, and no further — the service is called only by its own tests.
   Whatever `priorLimit` a real caller passes is the first evidence about the
   window, and reopens the default question.
2. **The count bound may be the wrong axis.** ADR-0065 alternative F: a time
   window is easier to explain but is weakest against exactly the case the check
   exists for — an agent regenerating a three-year-old post. Undecidable without
   real history.
3. **`indeterminate` is now reachable two ways** — short documents and truncated
   corpora. A caller that collapses it into `pass` defeats both at once, and
   nothing but the type system currently stops that.
