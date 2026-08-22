# ADR-0063 — The agent platform's data model composes with the systems that exist, rather than paralleling them

**Status:** Accepted
**Scope:** The Phase 0 data model for the multi-agent marketing platform —
`campaigns`, `agent_runs`, `agent_outputs`, `approvals`, `attribution_events`,
and the deferral of `channel_credentials`. Also the three reuse decisions the
model rests on. **No existing table changes shape.**
**Date:** 2026-08-22
**Deciders:** One engineer.
**Context as of this date:** Stage 7 has not started. No model is connected to
anything — `packages/contracts/src/ai/` holds a tested tool contract and an
invocation guard, and nothing calls them with an LLM behind it. There is no
orchestrator, no connector package and no approval UI. This ADR records the
shape of the tables those things will later write to.

## ⚠️ Why this is one decision and not four (README rule 1)

The README says one decision per record, and that a record needing "and also"
should be split. This one covers a table set **and** an autonomy reuse **and** a
credentials deferral **and** an attribution composition, which looks like four.

They are one decision applied four times. The agent platform is the first
subsystem in this repository large enough to have plausible reasons to
re-implement things the repository already has — a permission ladder, a
provenance record, a secrets store. Each of the three reuse calls below was
made by asking the same question and getting the same answer:

> Does the agent platform need a **new fact**, or a **new name for a fact that
> already has one**?

Splitting them into four records would file the shared reasoning four times and
leave no record of the rule itself. The rule is the decision. The tables are its
shape.

## Context

Phase 0 needs somewhere to record four things: that an agent ran, what it
proposed, what a human decided about the proposal, and what the proposal
eventually earned. Nothing in the repository records any of them today.

The architecture document has named the gap since it was written.
[`docs/architecture/ai-agent-architecture.md:170`](../architecture/ai-agent-architecture.md)
lists among what Stage 7 adds:

> **Run traces**: every tool call, argument, result and cost, per `runId`.

That `runId` is not hypothetical. It is already a required field on
`ToolContext` ([`ai/tool.ts:78`](../../packages/contracts/src/ai/tool.ts)),
described as _"correlates every tool call in one agent run, for tracing and
audit"_ — a foreign key with no table on the other end. `agent_runs.id` is that
table. The contract has been pointing at it since before it existed.

The original Phase 0 brief proposed six tables. Three of them proposed, as a
side effect, a second implementation of something the repository already has.

## Decision

**Every table in the agent platform records a fact that nothing else records.
Where the platform needs a concept the repository already owns, it references
the existing one rather than restating it.**

### The tables

| Table                | The fact it alone records                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `campaigns`          | A named, time-boxed unit that runs coordinate under. Nullable FK target — an agent may run outside any campaign.                                 |
| `agent_runs`         | One invocation: which agent, which workspace, which campaign, when, what status, what structured inputs. This is `ToolContext.runId`'s referent. |
| `agent_outputs`      | One draft or proposed action, and the autonomy level it was produced under.                                                                      |
| `approvals`          | What a human decided about one draft, when, and the edit if they rewrote it.                                                                     |
| `attribution_events` | That a published `agent_output` preceded a specific CRM outcome. Nothing more.                                                                   |

`agent_outputs.agent_run_id` is **`NOT NULL`, enforced by the database**, not by
application code. This is the provenance rule the whole model exists to protect:
an output that cannot name the run that produced it is not a record of anything.
A test must prove the _database_ refuses such a row, per AGENTS.md §6 — _"not
'validation ran' but 'the row was refused by the database'"_.

`agent_outputs.autonomy_level` is `smallint` with a `CHECK` between 1 and 4,
per AGENTS.md §5 — _"Limits live in the database."_ Phase 0 writes 2 to every
row and builds no auto-approve path.

### The three reuse calls

**1. Autonomy is `AutonomyLevel`, the one that already exists.**
[`ai/tool.ts:41`](../../packages/contracts/src/ai/tool.ts) defines four levels
— `RECOMMEND` 1, `DRAFT_WITH_APPROVAL` 2, `PRE_APPROVED` 3, `AUTONOMOUS` 4 — and
`invokeTool` enforces them as **step 4 of its six-step guard chain**
([`ai/registry.ts:12`](../../packages/contracts/src/ai/registry.ts)). The brief
proposed a new three-valued tier enum for `agent_outputs`. Rejected: see
alternative A.

**2. `channel_credentials` is deferred to the connector phase.**
Measured, not assumed: `grep` for `createCipheriv`, `createDecipheriv`,
`aes-256`, `encrypt(` and `decrypt(` across `packages/` and `apps/` returns
**nothing**. Every secret in this repository is one-way — HMAC and hash, in
`auth/session/tokens.ts`, `auth/invitations.ts`, `auth/password-reset.ts`.
There is no reversible-encryption primitive to store a credential with, and
inventing one was explicitly out of scope. See alternative B.

**3. `attribution_events` is a thin join, not a provenance record.**
`acquisitions` ([`schema/crm.ts:239`](../../packages/database/src/schema/crm.ts))
already carries `source_type`, `source_platform`, `confidence`, all five UTM
fields, `gclid`, `fbclid`, `landing_path`, `referrer_origin`, `channel_detail`
and `qualified_at`, under [ADR-0012](ADR-0012-provenance-model.md)'s rule that
provenance is captured at the moment of acquisition and cannot be reconstructed
afterwards. `attribution_events` adds exactly one fact to that: **which
`agent_output` preceded this acquisition or activity.** It re-records no channel
data. See alternative C.

## Alternatives considered

### A — A three-tier autonomy enum owned by the agent platform

What it is: a new enum on `agent_outputs` — something like
`suggest`/`draft`/`execute` — describing how independently the output was
produced.

Why it is attractive: it is scoped to outputs rather than to tools, and three
values are easier to render in an approval queue than four.

**Why rejected.** It gives the platform two answers to _"may an AI do this
without asking?"_, and the guard chain reads only one of them. `invokeTool`
checks `AutonomyLevel`; a tier column on `agent_outputs` would be decorative at
enforcement time and authoritative-looking at review time. The failure mode is
not that either vocabulary is wrong — it is that they can disagree, and the one
that drifts is the one nothing executes.

This is the same class of invariant as AGENTS.md §5's _"URL identity is
singular"_: the frontier, links, canonicals and sitemaps must not be able to
disagree about what "the same page" means. Autonomy is singular for the same
reason.

`packages/contracts/src/agents/enums.test.ts` holds this open as an executable
invariant: it enumerates the agents module's exports and fails if any name
matches `/autonom|tier/i`. It also asserts `Object.values(AutonomyLevel)` is
exactly `[1,2,3,4]`, so a fifth level cannot be added without the `CHECK`
constraint's bound being reconsidered in the same breath.

### B — Build `channel_credentials` now, in Phase 0

What it is: the sixth table from the original brief — per-workspace API tokens
for the channels agents would eventually publish to.

Why it is attractive: it is the obvious next table, and deferring it means the
connector phase opens with a migration rather than with code.

**Why rejected.** The repository has no reversible-encryption primitive
(measured above), so building the table in Phase 0 would mean inventing a
secrets pattern as a side effect of a data-model task — with no connector to
validate it against and no threat model written down. A credential store
designed speculatively, months before the first credential, gets its key
management decided by whoever needs it to work at the time.

Deferring costs one migration later. Getting it wrong costs a disclosure.

**This deferral is not a licence to store a credential elsewhere.** No table in
this model has a column a token may be put in. `agent_runs.inputs` is
structured input to a run, not a place for a secret.

### C — `attribution_events` as a self-contained record

What it is: give the join its own `source_platform`, `campaign`, UTM and channel
columns so a revenue report can be answered from one table.

Why it is attractive: one table, one query, no join to `acquisitions`.

**Why rejected.** It is a second provenance system. ADR-0012 exists because
provenance captured anywhere other than the moment of acquisition is
reconstruction, and reconstruction is fabrication with extra steps. An agent
publishing a post does not know which UTM the visitor eventually arrived on —
`acquisitions` does, from the source that actually knew. Copying those columns
onto the join would create a set of values that look authoritative, are written
by something that cannot observe them, and drift from the row that can.

ADR-0012 §7 already declined to denormalise first-touch onto the contact for
this reason. This is the same call.

### D — Collapse `agent_runs` and `agent_outputs` into one table

What it is: one `agent_actions` row per thing an agent did.

Why it is attractive: fewer tables, and Phase 0's runs mostly produce one output
each.

**Why rejected.** The cardinality is genuinely one-to-many — a run that produces
five variants of a post is one invocation and five drafts — and collapsing it
would either duplicate run metadata per draft or lose the fact that the five
shared a run. It would also make the `NOT NULL` provenance constraint
unexpressible: there would be no separate row for it to point at.

### E — A new `docs/architecture/agent-platform.md`

**Why rejected.** [`ai-agent-architecture.md`](../architecture/ai-agent-architecture.md)
already exists — 212 lines covering the agent hierarchy, the autonomy table, the
tool contract, the guard chain and the prompt-injection defences. A second
architecture document describing the same platform would split the autonomy
table across two files, which is alternative A's failure in prose form. This
ADR references it; it does not restate it.

## Consequences

### Positive

- `ToolContext.runId` gains a referent. The tracing gap the architecture
  document has named since it was written closes at the schema level.
- Provenance is enforced where it cannot be bypassed. An `agent_output` without
  a run is refused by PostgreSQL, not by a service that a future code path might
  not call.
- One autonomy vocabulary, held open by a test that fails if a second one starts
  appearing.
- The revenue question composes: `attribution_events → acquisitions` reuses
  ADR-0012's model rather than competing with it.
- Deferring `channel_credentials` keeps a secrets design out of a schema task.

### Negative

- **Answering "what did agents earn this month?" requires a join**, and
  `attribution_events` was built with no consumer. The columns a report wants
  may turn out to be wrong — deliberately accepted over guessing at every future
  report, but it is a real cost and the first consumer will likely need a
  migration.
- **The connector phase opens with a migration**, not with code.
- **Five tables with no writer.** Every one of them is written by code that does
  not exist yet. They are shaped by reasoning about what will write them, and
  reasoning is weaker evidence than a caller.
- **`agent_outputs.autonomy_level` is a constant in Phase 0.** Every row is 2.
  A column with one value is carrying capacity nothing exercises, and its first
  real test is the first time something writes a 3.
- **`campaigns` is coordination with nothing to coordinate.** No orchestrator
  exists. It is a nullable FK target and may sit empty for some time.

### Risks and mitigations

| Risk                                                                                  | Mitigation                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A future writer bypasses `agent_run_id` by making it nullable "temporarily"           | The constraint is `NOT NULL` at the database and proven by a test asserting the row is **refused**. Removing it means deleting a passing test.          |
| A second autonomy vocabulary appears anyway, in the database rather than in contracts | The `CHECK BETWEEN 1 AND 4` bound is asserted against `AutonomyLevel`'s values in `enums.test.ts`, so the two cannot drift silently.                    |
| The deferred credential store gets improvised into `agent_runs.inputs`                | Stated above as an explicit non-licence. The connector phase must write its own ADR before storing a secret.                                            |
| A new agent table ships without RLS                                                   | AGENTS.md §5 makes it an incomplete migration. Every table here is `ENABLE` + `FORCE`, proven by an integration test connecting as the restricted role. |

## Revisit when

- **The first connector needs a credential.** That phase must write its own ADR
  covering encryption at rest and key management, and undo alternative B's
  deferral explicitly rather than by adding a column.
- **The first attribution report is written.** If it cannot be answered by
  joining `attribution_events` to `acquisitions`, the thin-join decision was
  wrong and this ADR should be superseded rather than patched.
- **Anything needs to write an autonomy level other than 2.** That is the first
  moment the column is load-bearing, and the approval path it implies is not
  designed here.
- **A run needs to be cancellable.** `AGENT_RUN_STATUSES` deliberately omits
  `cancelled` because nothing can cancel a run today. `ToolContext.signal`
  exists, so this will change; adding the value is a migration and a decision
  about what a half-finished run's outputs mean.
