# ADR-0065 — Assembling a guardrail corpus is a separate service, and an incomplete corpus downgrades a pass rather than producing one

**Status:** Accepted
**Scope:** `packages/agents` — a new services package, its tenant context, and
`checkProposedOutput`. Also the capability reuse and the corpus-window
decision. **No schema changes**, and `packages/guardrails` is not modified:
[ADR-0064](ADR-0064-self-duplication-guardrail.md)'s purity decision is what
this ADR is built on, not a thing it revisits.
**Date:** 2026-08-23
**Deciders:** One engineer.
**Context as of this date:** No agent exists, no model is connected, no
connector exists. No workspace has ever published an `agent_output` — every row
in the five tables from migration 0014 is written by tests. This ADR records
the shape of the first service that reads them.

## Context

[ADR-0064](ADR-0064-self-duplication-guardrail.md) made `@growth-os/guardrails`
pure: it compares a draft against a corpus it is **given**, opens no socket and
imports no database. That is what lets a draft be checked _before_ it is
persisted, which is the only moment at which catching a duplicate is still
cheap.

Purity does not remove a responsibility; it moves one. Someone has to assemble
the corpus, and ADR-0064 recorded the gap that leaves in its own risk table:

> Nothing stops a caller passing an incomplete corpus, so duplicates pass
> unseen. Unavoidable given purity, and stated plainly here. The caller must
> fetch inside a tenant-scoped transaction; a future integration test at the
> call site is the real defence.

This is that call site. Until now the risk was documented; nothing could
detect it.

## Decision

**Corpus assembly is a service in a new `@growth-os/agents` package. It counts
what exists before it fetches, and when the corpus it compared against was
incomplete, a `pass` becomes `indeterminate`.**

### The package

`packages/agents` follows `packages/forms`'s context pattern, which follows
`packages/crm`'s: `AgentsContext`, `requireCapability`, `inTenant`. Same
tenant-scoped transaction, same capability check, same error types. The agent
platform is a different domain but not a different security model, and two
different security models is how one of them ends up weaker.

### ⚠️ No new capability

`workspace:ai:query` already exists in `contracts/src/tenancy/capabilities.ts`,
granted to `member`, `admin` and `owner` through the spread chain and **not** to
`viewer` — exactly the shape this service needs. It is reused.

A `workspace:agent_outputs:read` would be a second vocabulary for "may this
actor use the AI surface", and the one nothing else reads is the one that
drifts. This is the same call ADR-0063 made about autonomy, for the same
reason. Because no capability is added, AGENTS.md §5's "every new capability
ships with a grant test" does not fire — there is nothing new to grant.

### ⚠️ `priorLimit` is required and has no default

How much history counts as "what we have already published" is a product
question, and there is no data behind it: no workspace has published anything.

**Cost does not settle it either**, which was measured rather than assumed.
`evaluateGuardrails` against ~250-word drafts:

| Priors |      Total | Per prior |
| -----: | ---------: | --------: |
|     10 |     0.6 ms |  0.061 ms |
|    100 |     4.9 ms |  0.049 ms |
|  1,000 |    45.4 ms |  0.045 ms |
|  5,000 |   223.8 ms |  0.045 ms |
| 10,000 |   448.0 ms |  0.045 ms |
| 25,000 | 1,129.0 ms |  0.045 ms |

Cleanly linear at ~0.045 ms per prior. A realistic workspace publishing five
pieces a week accumulates ~260 a year, so comparison costs tens of
milliseconds. **The comparison is not what bounds the window — the fetch is**,
because the corpus is `jsonb` content loaded into memory.

So rather than bake a guess into a default, the caller states a limit and is
**told when that limit bound the answer**. A silent default would decide a
product question by accident, and the first person to hit it would never know.

### ⚠️ Truncation is counted, not inferred

The count is a separate query taken before the fetch. `rows.length === limit`
cannot distinguish "exactly the limit" from "more than the limit", and getting
that boundary wrong in the safe-looking direction reports a partial corpus as
complete.

### ⚠️ A `pass` over a truncated corpus becomes `indeterminate`

"Nothing matched among the 500 I looked at, and there are 3,000" is not a clean
bill of health. Downgrading it applies exactly the honesty ADR-0064 already
built into the word-count floor: the check says what it does not know instead
of folding it into `pass`.

**`fail` is never downgraded or upgraded.** Truncation can only hide matches;
it cannot invent one. A duplicate found against a partial corpus is still a
duplicate, and adding a completeness caveat to it would dilute a verdict that
is already correct.

## Alternatives considered

### A — Let guardrails fetch its own corpus

**Rejected in [ADR-0064](ADR-0064-self-duplication-guardrail.md) alternative A**
and not reopened here. It would make the check runnable only after the output
row existed, converting prevention into cleanup. This ADR exists because that
decision was made, not in spite of it.

### B — Define `workspace:agent_outputs:read`

Attractive: it names the resource precisely, and `workspace:<resource>:<action>`
is the documented naming rule.

**Rejected.** The rule governs how a capability is _named_, not whether a
second one should exist for a surface that already has one. Two capabilities
guarding the AI surface means a future check can consult either, and the one
the guard chain does not read is the one that drifts out of sync.

### C — Give `priorLimit` a sensible default

Attractive: callers do not have to think, and most would want the same number.

**Rejected.** There is no evidence for any particular number, and a default is
a decision that looks like a convenience. The measured cost curve is flat and
linear, so no number is forced by performance; picking one anyway would be
guessing with extra confidence.

### D — Infer truncation from `rows.length === limit`

Attractive: one query instead of two.

**Rejected.** It cannot tell "exactly the limit" from "more than the limit", so
a workspace with exactly `limit` published outputs would be reported as
truncated — and, worse, the natural fix (`>=` vs `>`) trades that false alarm
for a false clearance. A count is one cheap query and has no ambiguity. The
off-by-one is pinned by a test at limit 4 and limit 5 against 5 priors.

### E — Put the service in `packages/crm`

**Rejected.** The CRM owns contacts, companies, deals and provenance. Agent
runs and outputs are a different domain that merely joins to it via
`attribution_events`. Putting agent services there would make `crm` the place
where anything tenant-scoped goes.

### F — Bound the corpus by time rather than by count

Attractive: "the last twelve months" is easier to explain than "the last 500".

**Rejected for now, and worth stating why.** The check exists because a
stateless agent republishes what it cannot remember — and an agent regenerating
a post from three years ago is _more_ likely, not less. A time bound is
strongest against exactly the case the check was built for. A count bound at
least degrades predictably and reports when it bit. This should be revisited
with real data.

## Consequences

### Positive

- The incomplete-corpus risk ADR-0064 could only document is now **detected and
  reported**, with the boundary pinned by tests.
- `pass` from this service means "compared against everything published", which
  is the only reading under which a pass is worth anything.
- Guardrails stays pure; nothing about ADR-0064 is weakened to make this work.
- No second capability vocabulary, and no new grant surface to keep in sync.
- The window is an explicit caller decision, so the product question stays open
  and visible instead of being answered by a constant.

### Negative

- **Every caller must choose a number** with no guidance, because there is no
  data to give any. This is friction, deliberately.
- **Two queries per check** instead of one. Cheap, but not free.
- **`indeterminate` is now reachable two ways** — short documents and truncated
  corpora — and a caller that treats it as `pass` defeats both at once.
- **A count bound is arbitrary.** Alternative F is not wrong, just undecidable
  today; the first workspace with real history may show that time is the better
  axis.
- **Still no production caller.** This service is called only by its own tests.
  It is one layer closer to reality than ADR-0064's package was, and no further.

### Risks and mitigations

| Risk                                                                         | Mitigation                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A caller passes an absurdly small `priorLimit` and reads the result as clean | Truncation downgrades `pass` to `indeterminate` and names both numbers in the finding. `priorLimit < 1` throws rather than fetching nothing. |
| A caller collapses `indeterminate` into `pass`                               | Distinct value in a union type; the same defence ADR-0064 chose, and no stronger.                                                            |
| The corpus grows past what one fetch should load                             | `totalPublished` is reported on every call, so the growth is visible before it is a problem.                                                 |
| `agents` becomes a dumping ground for anything tenant-scoped                 | ESLint block restricting it to contracts, database and guardrails, plus a `agents → ui` boundary probe.                                      |

### ⚠️ One measurement that changed nothing, recorded because it is easy to misread

The service puts an explicit `workspace_id` predicate in the query as well as
relying on RLS, matching the CRM's IDOR defence. **Removing that predicate was
mutation-tested and all 16 tests still passed**, because `agent_outputs` is
`RLS ENABLE` + `FORCE` and the restricted role cannot see another tenant's rows
with or without it.

The predicate is therefore genuine defence-in-depth and is kept — but the
isolation test proves **RLS**, not the predicate, and nothing in this suite
could distinguish the two. That is stated here so a later reader does not
mistake a passing isolation test for evidence that the predicate is load-bearing.

## Revisit when

- **A production caller exists.** Whatever number it passes for `priorLimit` is
  the first real evidence about the window, and the default question reopens.
- **Any workspace accumulates enough published output to make the fetch hurt.**
  `totalPublished` on every result is the signal; the measured curve says the
  comparison stays cheap far longer than the fetch will.
- **A second check needs a different corpus.** The corpus shape is currently
  "published outputs, newest first" because one check needs exactly that. A
  second consumer with different needs makes this an interface question rather
  than a function-argument question.
