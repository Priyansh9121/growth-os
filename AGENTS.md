# Growth OS — Agent Operating Contract

This file governs every agent session in this repository. It is not advice. An
agent that violates a MUST here has failed the task even if the code works.

Reference it in the first line of every task brief:
`Read AGENTS.md in full before doing anything. It governs this session.`

`docs/VISION.md` is **not** a work instruction. Do not plan or scope from it.
Everything it constrains in present work is restated in §5 below.

---

## 0. Prime directive

**Verify, never recall.** Every claim about the repository must be produced by a
command run in this session. Never report state from memory, from earlier in the
conversation, or from a previous session's summary.

Before any work: `git rev-parse --short HEAD`, `git status --short`, and the test
suite. Before any summary: the same three, again. If you did not run the command,
you do not know the answer.

---

## 1. Method

This section outranks speed. It is the part that produces good work.

- **Measure before you diagnose.** Assume your first hypothesis is wrong until an
  artifact says otherwise. Source-level reasoning proposes; a measurement
  decides. Do not commit a conclusion you have only inferred from reading code —
  either take the measurement, or mark the finding provisional in the commit
  message itself, not only in a footnote.
- **Do not reason from an unverified premise.** If a claim is not in the
  repository or in a measurement you just took, say you have no record of it
  rather than building on it.
- **Prefer the cheap gate.** A test suite that runs in 1.3 s is a gate, not an
  investigation of last resort. Run it constantly.
- **Report negative results.** _"Measured X, changed nothing because of it"_ is a
  complete and valuable outcome. Never manufacture a change to justify a step.
- **Correct the brief when the brief is wrong.** A brief is a hypothesis about
  the work. If measurement contradicts it — wrong file count, wrong test target,
  wrong diagnosis — say so before proceeding, and say so in the commit subject
  when a finding contradicted the plan.
- **A standing instruction from a previous stage is never reversed by
  inference.** If a new brief appears to contradict a rule that has held for
  several stages, stop and confirm. Do not assume the reversal was intended.

---

## 2. Session integrity — the orphaned-output rule

Agent sessions die. Session limits, context exhaustion, crashes. The contract
must make a dead session harmless.

- **MUST** write the test file in the same unit of work as the implementation it
  covers. Not "after". Not "in a follow-up".
- **MUST NOT** produce more than ~300 lines of implementation without a passing
  test proving some of it. Large untested output is not partial progress; it is
  debt that looks like progress.
- **MUST** treat unreviewed code from a dead session as **deleted, not
  salvaged**. Do not read it, do not patch it, do not check whether it is mostly
  fine. Rebuild test-first. Auditing code you did not reason through is slower
  than rewriting it and produces code nobody understands.
- **MUST NOT** fan out parallel agents to WRITE code. Parallel sessions are for
  read-only investigation: probing behaviour, measuring, gathering evidence. Six
  agents writing code against a shared session budget is how ~2,000 lines of
  unreviewed parser output was produced and later deleted unread. An
  investigation that dies costs time; a build that dies costs trust in the tree.
- **MUST** end every session with the tree in one of two states: green and
  committed, or explicitly reported as unfinished with the exact failing thing
  named. Never leave ambiguity about which.

---

## 3. Scope control

- **MUST** do the task in the brief and stop. Adjacent improvements, refactors,
  renames and tidy-ups are out of scope unless the brief names them.
- **MUST** stop and report when the brief turns out to be wrong, underspecified,
  or blocked. A stopped agent with a clear question is a good outcome. An agent
  that guesses at a decision and builds on the guess is the worst outcome.
- **MUST NOT** expand a refactor mid-flight. If a move touches more files than
  the brief anticipated, report the delta before continuing.

---

## 4. Git discipline

- **MUST** commit in small logical slices, each independently green.
- **MUST NOT** commit a red tree. If a test fails, either fix it or exclude the
  incomplete work from the commit — never both broken and committed.
- **MUST NOT** commit a package that does not typecheck. A slice that fails
  `tsc --noEmit` is not a slice.
- **MUST** verify the remote exists and the work is pushed before declaring a
  stage complete. Uncommitted work on a machine with no remote is not work.
- **MUST NOT** create, change, or publish a remote without explicit instruction
  naming its visibility. Publishing a commercial multi-tenant codebase is
  irreversible within minutes.
- **MUST** verify `.gitignore` covers `node_modules`, `dist`, `.env*`, and local
  database or probe artefacts before any first push. If `git ls-files` surfaces
  anything credential-shaped, stop and report rather than committing.
- **MUST NOT** use `git add -A` blindly. Stage deliberately; read the diff.
- **MUST** commit with an explicit pathspec (`git commit -- <paths>`) or verify
  `git diff --cached --name-only` immediately before committing. Staging
  deliberately and then running a bare `git commit` commits the whole index —
  the same failure as `git add -A`, with extra steps. A `git mv` from earlier in
  the session is already staged and will be swept in silently.
- **MUST** verify each slice is independently green, not merely that the final
  tree is. A slice that only typechecks because a later slice fixes it is not a
  slice. Check out each commit and measure; do not infer it from the tip.
- Commit messages are declarative and state what changed and why. Where a
  finding contradicted the plan, say so in the subject.
- **MUST** land an ADR in the same commit as the code that cites it, never
  afterwards. A `@see ADR-00NN` pointing at a file that does not exist is worse
  than no citation: it reads as though the decision was recorded and reviewed.
  If the decision is not ready to write down, the code is not ready to commit.
- **MUST** commit the dev log entry in the same slice as the work it describes,
  exactly as an ADR lands with the code that cites it. A dev log written later is
  written from commit messages rather than from memory of the reasoning, and
  three tasks in this project were reported done without one.

---

## 5. Architectural invariants

Load-bearing. Breaking one is a security or correctness incident, not a style
disagreement.

**Network boundary.** `@growth-os/net` is the only package permitted to open a
socket. No other package may import `node:http`, `node:https`, `node:net`,
`node:dns`, `undici`, `axios`, or call `fetch` against a user-controlled URL. A
boundary probe test enforces this. If you need network access elsewhere, route
it through `@growth-os/net` — never add a second path.

**SSRF is structural, not a check.** Defence happens at every hop: URL
admission, address classification against the full IANA special-purpose
registries (deny-by-default, longest-prefix-wins, IPv4-mapped and NAT64
unwrapped), DNS resolution pinned to the validated literal so there is no
rebinding window, manual redirect handling where every hop re-enters the whole
pipeline, and two-tier body caps. **MUST NOT** add a fast path, a cache, or a
convenience wrapper that skips any hop.

**Tenancy.** Every workspace-owned table is `RLS ENABLE` **and** `FORCE`.
Exceptions require an ADR naming the table and the reason. A migration that adds
a workspace-owned table without RLS is incomplete.

**Limits live in the database.** Budget ceilings, page caps and rate limits are
CHECK constraints, not application validation. The test for a constraint is a row
that must be _refused_.

**Capability naming** follows `workspace:<resource>:<action>` exactly. Every new
capability ships with a grant test proving each role gets what it should and
nothing more.

**Stage boundary — facts vs findings.** The crawler _acquires facts_. The audit
layer _interprets them into findings_. `title = ""` is a fact. "Missing title,
severity high" is a finding. **MUST NOT** put severity, scoring, recommendations
or judgement in the crawl layer, however convenient.

**URL identity is singular.** One `normaliseUrl`. The frontier, links,
canonicals, redirects and sitemaps must not be able to disagree about what "the
same page" means. Never normalise inline.

### Architectural horizon

Four constraints the long-range product imposes on present work. Nothing else
from `docs/VISION.md` binds today's decisions.

1. **Page identity is durable across crawls.** Change detection requires a page
   entity keyed on `(site_id, normalised_url)` that crawl results attach to.
   Page rows scoped only to a `crawl_id` make change detection a migration and a
   backfill later.
2. **Crawl entities emit events.** Every layer above stage 4 subscribes to what
   the crawler learns. Facts that never emit are invisible to automation.
3. **Tenancy holds to agency-of-agencies depth.** Isolation that works one level
   deep will need rebuilding for white label and multi-client management.
4. **No hardcoded branding.** Anywhere.

---

## 6. Test standards

- **MUST** prove the strong property, not the weak one. Not "an error was
  returned" but "no socket was opened", using a transport that throws if called.
  Not "validation ran" but "the row was refused by the database".
- **MUST** test hostile input for anything parsing the outside world: malformed
  directives, XML entity expansion, unclosed tags, wrong encodings, redirect
  loops, compression bombs, absurd nesting.
- **MUST NOT** weaken, skip, or delete a failing test to get green. If a test is
  genuinely wrong, say so explicitly and explain why.
- **MUST NOT** assert a test count you have not observed. Report the number the
  runner produced. If a brief names a target that measurement contradicts,
  correct the brief (§1).
- Fixtures are synthetic and committed. Tests never reach the network.

---

## 7. Definition of done

A task is done when **all** of these hold, each verified by a command run in this
session:

1. **`npm run verify:all` passes** — state the observed test count
2. Migrations apply from zero on a throwaway database, then it is destroyed
3. **`npm run verify:e2e` passes** — state the observed test count. Required
   when the change could reach a browser: anything in `apps/web`, `packages/ui`,
   the design tokens, or a route. Skippable only for changes that provably
   cannot — say which, and why, rather than omitting it silently.
4. Committed in logical slices, each independently green, tree clean, pushed
5. An ADR exists for every non-obvious decision made
6. Dev log entry written

Anything short of all six is reported as unfinished, with the gap named.

### ⚠️ Why (1) defers to the repository instead of listing the checks

It used to enumerate them: tsc, lint, unit suite, boundary probes. An agent
followed that list exactly and still shipped eight unformatted files, because
the list said "lint" and the repository's real gate also runs `format:check`.

**That was a contract bug, not an agent error.** A parallel list of checks
drifts from the thing it is a copy of, and the copy is always the one that is
wrong. `verify:all` is the repository's own answer to "is this shippable"; when
a gate is added there it applies here immediately, with nothing to remember.

Today that is `format:check`, `lint`, `typecheck`, `test`, `verify:boundaries`
and `verify:gitignore`.

**(2) and (3) stay separate on purpose — the database tier.** `verify:all` cannot
run either: (2) needs a database, and (3) needs a database, a production build
and a browser. Folding either in would delete the check rather than inherit it.

(2) is the gate that catches a migration which passes review and fails on a
fresh schema, which is every migration's first real test.

(3) is the gate that catches what no unit test can see. Three consecutive
sessions shipped or nearly shipped browser-only defects — a CSS cascade bug that
made three of five themes render as a fourth, and a class-merging bug that left
every primary button's label at 1.47:1 contrast. Both were invisible to a green
`verify:all` because the values were right and only the rendered result was
wrong.

⚠️ **`verify:e2e` FAILS when it cannot run; it never skips.** That is the
opposite of the integration suite, which self-skips without a database so a
developer with no PostgreSQL still gets a useful `verify:all`. Applying that
trade to a browser gate would produce a green result having run no browser,
which is the failure this section is about.

⚠️ **It is honest about what it does not cover.** The e2e suite tests auth, CSP,
CRM, lead capture and lifecycle. It does **not** test themes, colour or
contrast — neither of the two defects above would have been caught by running
it, and both were found by writing a throwaway browser probe. Running (3) is not
a substitute for looking at the thing you changed.

---

## 8. Reporting

Every session ends with a report stating:

- **What was verified** — with the commands that produced the evidence
- **What was built** — and which tests prove it
- **What is unverified or unfinished** — plainly, without softening. _"I have not
  reviewed this and would not trust it as-is"_ is the correct register.
- **What is next** — the single next task, not a wishlist

**MUST NOT** describe unreviewed code as complete. **MUST NOT** report a test
count without running the suite. **MUST NOT** paper over a half-finished
refactor as a passing build.

---

## 9. Task brief template

One task, one brief.

```
Read AGENTS.md in full before doing anything. It governs this session.

TASK: <one sentence>

WHY: <what this unblocks>

IN SCOPE:
- <specific files or behaviours>

OUT OF SCOPE:
- <the adjacent things you must not touch>

INVARIANTS THAT APPLY:
- <the specific §5 invariants this task could break>

DONE WHEN:
- <the specific green condition>
- <committed in logical slices, pushed>

FIRST: verify current state (HEAD, git status --short, test count) and report it
before writing any code. If it does not match this brief's assumption, stop and
say so.
```

---

## 10. Current briefs

### Brief A — stabilise and commit

Revised against measurement: five importers, not one; `@growth-os/sites` does not
currently typecheck; the test target was wrong.

```
Read AGENTS.md in full before doing anything. It governs this session.

TASK: Finish the @growth-os/sites extraction, get the suite green, delete
orphaned parser output, and commit all proven Stage 4 work in logical slices.

WHY: Every line of Stage 4 is uncommitted on main with no remote. This is the
highest-risk state in the project and outranks any new work.

IN SCOPE:
- Fix @growth-os/sites so it typechecks. Two known failures: the missing
  '../shared/context' and '../shared/origin' imports in service.ts, and the
  Drizzle generic error at context.ts:146. A package that fails tsc is not a
  committable slice.
- Rewire all five importers of the moved modules:
    packages/forms/src/index.ts (two re-exports)
    packages/forms/src/public/submit.ts (production code)
    packages/forms/src/public/public-path.test.ts
    packages/forms/src/lead-capture.integration.test.ts
    packages/sites/src/service.ts
- Delete packages/crawler/src/robots/parse.ts and
  packages/crawler/src/parser/extract.ts WITHOUT READING THEM. Orphaned output
  from a killed workflow, unreviewed, untested, parsing hostile input.
- Verify .gitignore before the first push (§4).
- Create the remote: GitHub PRIVATE. Never public. Create it at the commit step,
  not before — the rewiring and deletions carry no disclosure risk and should
  not block on it.
- Commit in slices, each independently green and typechecking:
  (a) @growth-os/net  (b) crawler URL identity  (c) migration 0008 + schema
  (d) contracts and capabilities  (e) the sites extraction. Push each.

OUT OF SCOPE:
- Any new parser work. The sitemap directory. Crawl services. UI. Any ADR beyond
  what already exists.

INVARIANTS THAT APPLY: §2 orphaned output, §4 git discipline and remote
visibility, §6 no weakened tests and no asserted counts.

DONE WHEN:
- public-path.test.ts passes; total unit count materially above 584 (expect
  roughly 630) — report the observed number, do not target a specific integer
- tsc --noEmit clean across all affected packages including @growth-os/sites
- lint clean, git status --short empty, all slices pushed

FIRST: verify current state and report it before writing any code.
```

### Brief B — rebuild the robots parser, test-first

```
Read AGENTS.md in full before doing anything. It governs this session.

TASK: Implement robots.txt fetching and evaluation in packages/crawler/src/robots,
test-first, from scratch.

WHY: The crawler must not fetch what it has been told not to fetch. Correctness
requirement and the politeness contract with customers' sites.

IN SCOPE:
- Parse: group merging across repeated User-agent lines, Allow/Disallow with
  longest-match-wins and Allow-wins-on-tie, '*' and '$' wildcards, Crawl-delay,
  Sitemap directives (absolute, collected regardless of group).
- Evaluate: given a normalised URL and our user-agent token — allowed or not,
  and which rule decided it. The reason must be reportable, not just a boolean.
- Fetch semantics: 2xx applies the rules; 4xx means unrestricted; 5xx and
  network failure mean treat the whole site as disallowed until it recovers;
  oversized or malformed bodies fail closed. Fetch through @growth-os/net only.
- Hostile-input tests per §6: absurd line counts, no groups, only comments, BOM,
  CRLF, non-UTF8 bytes, conflicting rules, unicode paths, 100KB of wildcards.

OUT OF SCOPE:
- Sitemap XML parsing. HTML extraction. The frontier. Anything downstream.

INVARIANTS THAT APPLY: §5 network boundary, URL identity, facts vs findings
(report the deciding rule, never a severity).

DONE WHEN:
- Tests written before or alongside the code
- Full suite green, observed count stated and higher than the Brief A baseline
- An ADR records the fail-closed-on-5xx decision
- Committed and pushed

FIRST: verify current state and report it before writing any code.
```
