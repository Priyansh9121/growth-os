# ADR-0064 — The self-duplication guardrail is a pure function over a corpus it is given, and it is allowed to say "I cannot tell"

**Status:** Accepted
**Scope:** `packages/guardrails` — the check pipeline, the self-duplication
check, its two measured constants, and the two checks named in the Phase 0
brief that are deliberately **not** implemented. **No schema changes.**
[ADR-0063](ADR-0063-agent-platform-data-model.md)'s data model is untouched.
**Date:** 2026-08-23
**Deciders:** One engineer.
**Context as of this date:** No agent exists. No model is connected. No
connector exists, so no output has ever been published to any platform. The
five agent tables from migration 0014 are written only by tests. This ADR
records the shape of a check that nothing calls yet.

## Context

An agent with no memory of what it published last month will publish it again.
That is not a hypothetical: it is the _default_ behaviour of a stateless
generator pointed at a stable brief. Two near-identical pages compete in search
and the engine picks a winner, which may be the wrong one; the same email goes
to the same list twice.

The Phase 0 brief asked for a guardrails package with three checks —
self-duplication, platform ToS / rate limits, and disclosure compliance — and
scoped only the first to this phase.

`agent_outputs.content` is `jsonb` whose shape varies by `kind`, so a
duplication check cannot rely on structure. Duplication is a property of the
prose.

## Decision

**The guardrail is a pure function. It is given the corpus to compare against
and returns a verdict with reasons. It never fetches anything.**

`evaluateGuardrails({ proposed, priors })` runs every check and returns
`{ outcome, findings }`. One check exists: `self-duplication`.

### Purity is what makes it useful, not just tidy

The package has zero dependencies, opens no socket and imports no database. The
caller supplies `priors`. This is enforced by lint — a `packages/guardrails`
block forbidding `@growth-os/*`, plus the existing global socket rule — and
proven by two probes in `verify-boundaries.mjs` that assert the imports are
rejected.

The reason is not aesthetic. **A pure check can run before the output is
persisted**, which is the only moment at which catching a duplicate is still
cheap. A check that queried `agent_outputs` itself could only ever run after
the row existed, turning prevention into cleanup.

### Similarity is word-shingled Jaccard

Text is extracted from the `jsonb` (strings only, keys ignored, object keys
sorted for determinism), normalised, cut into overlapping 3-word shingles, and
compared by Jaccard. Both constants below were **measured**, not chosen.

`SIMILARITY_THRESHOLD = 0.30`, against a 51-shingle marketing draft:

| Candidate                                       | Similarity |
| ----------------------------------------------- | ---------: |
| identical                                       |      1.000 |
| identical, repunctuated and recased             |      1.000 |
| the same prose split across different fields    |      0.925 |
| republished with one extra paragraph appended   |      0.721 |
| lightly reworded — synonym swaps, same skeleton |      0.384 |
| **different topics sharing trade boilerplate**  |  **0.246** |
| heavily rewritten, same topic and facts         |      0.000 |
| unrelated draft                                 |      0.000 |

0.30 sits in the gap between the worst measured false positive (0.246) and the
weakest true one (0.384).

### ⚠️ A third outcome, forced by measurement

The brief specified pass/fail. Measurement made that dishonest. Holding two
genuinely **different** topics constant, sharing one boilerplate sentence, and
growing the unique body:

| Words | Similarity |                                     |
| ----: | ---------: | ----------------------------------- |
|    20 |      0.714 | ⚠️ higher than a real republication |
|    25 |      0.484 | ⚠️ would falsely flag               |
|    30 |      0.366 | ⚠️ would falsely flag               |
|    35 |      0.294 | crossover                           |
|    40 |      0.246 |                                     |
|    50 |      0.185 |                                     |
|    80 |      0.113 |                                     |

A shared stock sentence is most of a short draft and almost none of a long one.
Below **`MIN_COMPARABLE_WORDS = 40`** the check returns `indeterminate` rather
than guessing — including when the draft is an obvious duplicate, because being
right by luck at a length where the method is usually wrong is not a property
worth shipping.

`indeterminate` is not `pass`, and the type forces a caller to notice: a caller
that collapses them has turned "I could not tell" into "I checked and it is
fine".

### Only published priors are compared

A draft that a human rejected or sent back for edits still sits in
`agent_outputs`. Comparing against it would flag the _corrected_ version as a
duplicate of the thing it was corrected from — the guardrail would fire hardest
exactly when a human had already done the right thing.

### The other two checks are ABSENT, not stubbed

Platform ToS / rate limits and disclosure compliance are **not implemented and
have no placeholder**. A stub returning `pass` is indistinguishable from a check
that works, which is the precise failure `verify-boundaries.mjs` exists to
prevent elsewhere in this repository.

They cannot be written yet. "How many posts per day may this account make" has
no answer until a connector with a platform behind it exists; disclosure rules
depend on jurisdiction and channel, and the product has settled neither.
`GuardrailCheck` is the seam they slot into, and that is the entire commitment
this phase makes about them. A test asserts `PHASE_0_CHECKS` has exactly one
entry, so adding an always-passing placeholder fails the suite.

## Alternatives considered

### A — Let guardrails query `agent_outputs` itself

Attractive: the caller does not have to assemble a corpus, and the check cannot
be given the wrong one.

**Rejected.** It could then only run after the output row existed. The check
would become cleanup rather than prevention, and the package would acquire a
database dependency, a tenancy responsibility and an RLS story it does not need.
Passing the corpus in keeps all three where they already are — with the caller,
inside a `withTenantTransaction`.

The cost is real and accepted: **nothing stops a caller passing an incomplete
corpus**, and a check that compares against nothing returns `pass`. See risks.

### B — Levenshtein / edit distance

Attractive: the textbook "how similar are these strings" answer.

**Rejected.** It is O(n·m) — on two 2,000-word drafts that is millions of cell
computations per comparison, against every prior. Worse, it measures the wrong
thing: edit distance treats a reordered paragraph as almost entirely different,
while shingling correctly sees the same sentences.

### C — Embedding / semantic similarity

Attractive: it would catch the "heavily rewritten, same topic" case that scores
0.000 here, which is arguably the most valuable catch of all.

**Rejected for this phase.** It requires a model. No model is connected
(`ai-agent-architecture.md`), and calling one would make the package impure,
network-dependent and billable — reversing every property decided above. It is
the obvious future upgrade and is named in "Revisit when".

**This is a real, acknowledged gap:** a genuinely rewritten duplicate of the
same argument passes this check today.

### D — Pass/fail only, as the brief specified

**Rejected by measurement**, not by preference. At 20 words, two different
drafts sharing boilerplate scored 0.714 — higher than a genuine republication
with a paragraph appended (0.721 is barely above it). Any two-valued verdict in
that regime is a coin flip presented as a judgement.

### E — Stub the unimplemented checks so the roster looks complete

**Rejected.** See above: a check that always passes looks exactly like a check
that works, and the first person to trust the roster would be trusting nothing.

### F — Compare against unpublished drafts too

Attractive: catches two near-identical drafts produced in the same run.

**Rejected.** It would flag a corrected draft as a duplicate of the rejected one
it corrects. The same-run case is better handled at the point where a run emits
multiple outputs, which does not exist yet.

## Consequences

### Positive

- The check can run before an output is persisted, which is when prevention is
  still possible.
- Purity is enforced by lint and proven by two boundary probes, not asserted in
  a comment.
- Both constants are reproducible: the fixtures in the test file **are** the
  calibration corpus, so moving a threshold fails the boundary case and says
  which direction it moved.
- Cross-workspace corpus entries throw rather than being filtered, so a tenancy
  bug cannot present as a clean pass.
- `indeterminate` makes the check's own uncertainty legible instead of hiding it
  inside `pass`.

### Negative

- **A rewritten duplicate passes.** Same argument, same facts, new sentences
  scores 0.000. This check catches republication and light editing, not
  paraphrase.
- **The false-positive margin is 0.054** (0.246 measured vs a 0.30 threshold),
  which is not comfortable. Accepted because every Phase 0 output is
  human-reviewed at autonomy level 2 regardless, so a false flag costs one line
  in a review that was already happening while a miss costs a republication.
- **Both constants were calibrated on hand-written English marketing copy.**
  Eight pairs and one length sweep are a small sample, and nothing here has been
  validated against another language or another content type.
- **Nothing calls this.** Like the tables in ADR-0063, it is shaped by reasoning
  about its caller rather than by one.
- **Short drafts get no verdict at all** — headlines, ad copy and subject lines
  are all under 40 words, so the check is silent on an entire class of output.

### Risks and mitigations

| Risk                                                            | Mitigation                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A caller passes an incomplete corpus, so duplicates pass unseen | Unavoidable given purity, and stated plainly here. The caller must fetch inside a tenant-scoped transaction; a future integration test at the call site is the real defence. |
| A caller treats `indeterminate` as `pass`                       | Distinct value in a union type rather than a boolean, so collapsing them is a visible decision in the caller's code.                                                         |
| Someone adds a placeholder check that always passes             | `PHASE_0_CHECKS` length is asserted in `pipeline.test.ts`.                                                                                                                   |
| A threshold is tuned by feel until a failing case goes away     | The calibration corpus is the test fixture set; retuning breaks the boundary tests, which name the measured values.                                                          |
| Guardrails grows a database or network import                   | Lint rule plus two `verify-boundaries.mjs` probes that assert the imports are rejected.                                                                                      |

## Revisit when

- **A model is connected.** Embedding similarity (alternative C) would close the
  paraphrase gap, and this ADR should be superseded rather than amended.
- **The first connector lands.** That is when platform ToS / rate-limit rules
  become writable, and when disclosure rules acquire a jurisdiction.
- **A real corpus exists.** Both constants were calibrated on invented copy.
  The first few hundred real published outputs are the sample that should
  re-derive them — and if the measured false-positive ceiling exceeds 0.246 in
  practice, 0.30 is too low.
- **Short-form output matters.** If ad copy or subject lines become a primary
  output, `indeterminate` on everything under 40 words stops being acceptable
  and needs a different method, not a lower floor.
