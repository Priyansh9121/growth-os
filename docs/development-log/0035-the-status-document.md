# 0035 — The status document, and the house style that stops at the backend

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Produce `docs/PROJECT-STATUS.md` from direct measurement, and audit — not
rewrite — documentation coverage across the codebase. **Report only; the single
permitted code change was a capped set of comment-only docblock additions, and
the cap was exceeded, so none were made.**

The argument for the brief is in the project's own history. Five sessions
([0026](0026-one-absolute-url-test.md), [0027](0027-the-field-target-cap.md),
[0028](0028-one-like-escaper.md),
[0029](0029-the-body-ceiling-and-a-backlog-pass.md),
[0033](0033-sitemap-discovery-reaches-the-frontier.md)) each found that a
previous dev log's own "Remaining work" claim had gone stale. The dev logs are
an append-only trail; nothing in the repository answered "what exists now" in
one place. A hand-maintained summary would have become the sixth stale claim, so
this one is built by running the checks and is marked regenerate-wholesale in
its own header.

Precedent: [0018](0018-the-regex-sweep.md), which audited every regex in the
repository and fixed nothing.

## Initial state

Verified, not recalled: `1c1ad9a`, tree clean, `verify:all` exit 0, **1240
passed / 245 skipped (1485)**, 30 test files passed / 12 skipped (42), 29
boundary probes, remote `Priyansh9121/growth-os` PRIVATE, `0 0` ahead/behind.

Matched the brief's stated assumption exactly. Nothing to correct before
starting — which, given §1, is worth recording as the unusual case.

## Method

Nothing below was read out of a dev log and carried forward. Every figure has a
command behind it, and where a prior log's claim was re-checked, it was
re-checked against `1c1ad9a` rather than against the log that made it.

- **Per-package gates** — `npm run typecheck --workspace <pkg>` and `npx eslint
  <dir>` run once per workspace, standalone, rather than inferring from the
  monorepo aggregate. All 11 green.
- **Per-file test attribution** — `vitest run --reporter=json`, then the 42
  files bucketed by package. The buckets sum to 1240 / 245, which is the check
  that the attribution is complete and not merely plausible.
- **§7.2 from zero** — a `growth_os_throwaway_0035` database created empty, all
  10 migrations applied by `npm run db:migrate`, the whole suite run against it,
  then dropped.
- **Docblock coverage** — a script over `git ls-files`, not `find`, so untracked
  scratch files cannot inflate the denominator.

## Finding 1 — the two test counts, and why quoting one is wrong

`verify:all` runs `vitest run` with `TEST_DATABASE_URL` unset. The integration
project skips itself rather than failing, by design (`vitest.config.ts`), so the
headline number is the suite _minus every test that needs PostgreSQL_.

| Run                                 | Test files              | Tests                                 |
| ----------------------------------- | ----------------------- | ------------------------------------- |
| `verify:all` (no database)          | 30 passed \| 12 skipped | **1240 passed \| 245 skipped (1485)** |
| Full suite against the throwaway DB | **42 passed (42)**      | **1485 passed (1485)**                |

Exit 0 both times; 8.52 s and 21.04 s respectively.

**245 of 1485 tests — 16% — never execute in the default gate.** That is not a
defect: §7.2 exists precisely because `verify:all` cannot run them. It does mean
"the test count" is an ambiguous phrase in this repository, and the status
document states both numbers side by side rather than picking one.

## Finding 2 — the crawler is complete and unreachable

Every Stage 4 capability the brief named is built and tested. Confirmed by
measurement rather than assumed, including the negative:

| Capability                   | Tests                |
| ---------------------------- | -------------------- |
| URL normalisation            | 158                  |
| robots.txt parse / fetch     | 103 / 30             |
| Sitemap parse / fetch / walk | 31 / 20 / 14         |
| Frontier admission           | 50                   |
| Frontier persistence         | 30 (database)        |
| Sitemap → frontier           | 7 (database)         |
| Page fetch                   | 20                   |
| Orchestrated crawl run       | 8 (database)         |
| **HTML link extraction**     | **no module exists** |

**The extraction check was the one most worth doing properly**, because the
package's `package.json` lists `htmlparser2` and that reads like evidence of an
HTML parser. It is not. The only import is `sitemap/parse.ts:24`, in
`{ xmlMode: true }`. Every other `href`/`anchor`/`link graph` hit in the package
is a comment or a test fixture. `run/crawl.ts:20` says so itself.

### ⚠️ What the audit found that no dev log has recorded

**`@growth-os/crawler` has zero consumers.** No `package.json` under `packages/`
or `apps/` lists it. `apps/worker/src/jobs.ts` registers three jobs, none a
crawl. `apps/web/src/app/api/` has 23 routes, none a crawl. The three
`workspace:crawls:*` capabilities exist at
`contracts/tenancy/capabilities.ts:171–173` and have **no enforcement call site
anywhere** — the only match outside the definition is a comment in
`frontier/frontier.ts:19` reasoning about a caller that does not exist.

Individually every session was right that its piece was done. Nobody had asked
the composed question. That is exactly the gap a status document is for, and it
is the reason this one distinguishes _wired_ from _built but unreached_ rather
than listing features.

## Finding 3 — 0018's list really is closed

0029 declared 0018's ten-item list closed; 0031 declared the Stage 4 cleanup
backlog empty. The brief asked whether anything on it silently was not.

**Nothing is.** Each item was re-measured at `1c1ad9a`, not read from the log
that closed it. The strongest single check: `grep` for `/^https?:\/\//i` across
all non-test source returns **zero** — 0018 counted four copies, 0026 found a
fifth, and all five now delegate to `contracts/url/http-url.ts`.

Two items were also confirmed closed _as accepted rather than fixed_, which the
carried-forward prose obscured: `neutraliseCsvFormula` still has no production
caller (the document that claimed it was live was corrected instead), and
`splitLandingUrl` still has no production caller by design — it is the
differential oracle for the property test at `public-path.test.ts:374`. Four dev
logs described the latter as "dead code" before `dd2f1f2` measured it.

## Finding 4 — the house style stops at the backend

The brief expected the undocumented count to be "small or zero, given the house
style", and capped fixes at 10.

Ten existing files were read first to establish what the convention actually is
rather than assuming: a top-of-file `/** … */` block, strongest form opening
with a summary and an `ARCHITECTURAL RESPONSIBILITY` section, `⚠️` paragraphs
naming the specific failure the file prevents, `@see` links to ADRs. The check
applied was the weakest possible bar — _does the file open with a block comment
at all_ — so the count is a floor.

**222 non-test files in scope. 162 documented. 60 with nothing.**

### ⚠️ 60 is six times the cap, so nothing was fixed

Even the narrowest reading of the brief — `.ts` only, excluding `.tsx` — is 25.
Per §3 and the brief's own instruction, **no docblock was added and no existing
comment was touched.** Reported for a future session with a proper brief.

### The interesting part is where the 60 are

| Root                                                    | Files | Undocumented |
| ------------------------------------------------------- | ----: | -----------: |
| crawler / crm / database / forms / net / sites / worker |    77 |        **0** |
| `packages/auth`                                         |    15 |            3 |
| `packages/contracts`                                    |    29 |            9 |
| `packages/ui`                                           |    14 |       **11** |
| `apps/web/src`                                          |    90 |       **37** |

**Seven roots are at 100%. Two roots hold 48 of the 60.** The convention is not
repo-wide and never was — it is a backend-package convention that hardened
around Stage 2, and `packages/ui` and `apps/web/src` are largely stages 1–3
work that predates it. 14 of the 60 are pure re-export barrels of 1–8 lines;
the remaining **46 are substantive**, several of them large: `import-wizard.tsx`
(372 code lines), `form-renderer.tsx` (357), `merge-panel.tsx` (288),
`crm-tools.ts` (258 — an AI tool surface), `lattice-scene.tsx` (243).

This is why the cap was the right instruction. Documenting 46 files in one
session would mean inventing 46 explanations from a cold read, and a confident
wrong explanation of an AI tool surface is worse than an absent one.

## Other findings, recorded not fixed

1. **`AGENTS.md` §10 is stale.** It still carries Brief A and Brief B verbatim
   from the first session; both are complete and measurably so — `sites`
   typechecks, `packages/crawler/src/parser/` does not exist, the remote exists
   and is PRIVATE, `robots/` has 133 passing tests and ADR-0035 records the
   fail-closed-on-5xx decision. A reader taking §10 literally would rebuild
   finished work. **`AGENTS.md` is out of this brief's scope and was not
   edited.**
2. **`contracts/crawl/enums.ts:215` claims a test that does not exist** — _"the
   two lists are kept in agreement by a test rather than by an import"_. There
   is no test comparing `CRAWL_FAILURE_CATEGORIES` to `net`'s `FetchFailure`.
   Found by 0034, confirmed still open. Same class as `neutraliseCsvFormula`.
3. **The RLS exception rationale is not in an ADR.** §5 requires _"an ADR naming
   the table and the reason"_. `docs/security/tenant-isolation.md:101–141` names
   all nine non-RLS tables with a reason each, and `schema/jobs.ts` argues its
   own case citing `@see ADR-0030` — but **ADR-0030 contains zero occurrences of
   "RLS" or "row level"**. The reasoning is sound and documented; it is not
   where §5 says to look.
4. **A garbled sentence in a security docblock.** `schema/forms.ts:266`: _"it is
   consulted before the tenant is known is false — the form resolves first"_.
   Two clauses collided. Not edited — this brief forbids touching existing
   docblocks, and that rule is worth more than this sentence.
5. **Playwright is not in `verify:all`.** Four specs under `tests/e2e/` contain
   56 `test(` occurrences by grep — **the suite was not run this session**, so
   that is a count of call sites, not of passing tests. A 12,840-line React app
   is covered by a suite the gate does not execute.

## Negative results

Worth stating, because the brief asked and the answer was "nothing wrong":

- **ADR index integrity: clean.** 53 files, 53 rows, no mismatch either
  direction. All 53 are cited from source, and every `@see ADR-00NN` in source
  resolves to a file.
- **Dev log index integrity: clean.** 34 files, 34 links, no mismatch.
- **Per-package gates: clean.** All 11 workspaces typecheck and lint standalone.
- **Tenancy invariant holds under measurement**, not just review. Running
  `tenant-isolation.md`'s own SQL against the migrated database returns exactly
  one workspace-owned table without `ENABLE AND FORCE`: `memberships`, the
  documented exception. 26 have both.

Nothing was silently fixed. Every mismatch check that could have produced a
quiet edit produced no finding instead.

## Files

| File                             | Change                                |
| -------------------------------- | ------------------------------------- |
| `docs/PROJECT-STATUS.md`         | New. 449 lines, regenerate-wholesale. |
| `docs/README.md`                 | Two entries pointing at it.           |
| `docs/development-log/0035-…`    | This entry.                           |
| `docs/development-log/README.md` | Index row.                            |

**No source file was touched.** `git diff --stat` over `packages/` and `apps/`
is empty.

## Testing

No test was added, because no behaviour changed. The suite is the control:

- Before: `verify:all` exit 0, **1240 passed / 245 skipped (1485)**, 29 boundary
  probes.
- After: `verify:all` exit 0, **1240 passed / 245 skipped (1485)**, 29 boundary
  probes.
- §7.2: throwaway database migrated from zero, full suite **1485 passed
  (1485)**, exit 0, database dropped.

Re-run in full rather than lint-only, per the brief — the point of an
unchanged count after a documentation-only session is that it is _observed_,
not assumed.

## Result

`docs/PROJECT-STATUS.md` exists and every figure in it was produced by a command
in this session. The documentation-coverage count is **60 of 222**, six times
the fix cap, so the list was reported and nothing was edited.

The most useful thing the audit produced is not a number. It is that the
crawler — eleven test files, 5,014 lines of test code, more test than source —
has no caller, no job, no route and no capability check anywhere in the system.
Every session that built a piece of it was right that the piece was done. The
composed question had not been asked.

## Remaining work

Ranked, and re-measured rather than carried:

1. **HTML link extraction.** The single largest limit on what the crawler can
   do: without it a site with no sitemap yields a one-page crawl, and Stage 5
   has almost no facts to interpret.
2. **The missing enum-agreement test** (finding 2 above). Small, self-contained,
   and a file currently claims it exists.
3. **`AGENTS.md` §10.** Out of scope here and named in the status document. It
   needs a session that is allowed to edit that file.
4. **A documentation brief for the 46 substantive gaps**, scoped per directory
   rather than all at once — `packages/ui` (11) is the cheapest coherent slice.

Carried, unchanged and re-measured this session: the local dev database at 8 of
10 migrations (0000–0007, unchanged since 0023 first recorded it), the
permanently deferred client-side email regex, and 0030's open question about the
4× expansion ratio — **now at four call sites, up from the three 0030 recorded**,
since `pages/fetch.ts:60` added one.
