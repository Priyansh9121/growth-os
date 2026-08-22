# 0052 — The threshold that moved with length

**Date:** 2026-08-23 · **Stage:** 7 (Phase 0)

## Objective

The guardrails package: one check that asks whether a proposed agent output is
something this workspace has already published.

## Initial state

Verified, not recalled: `b2a61f7`, tree clean, `## main...origin/main` in sync.

Both suite states, because only one of them is a baseline for this work:

- `env -u TEST_DATABASE_URL npm test` → **1497 passed / 345 skipped (1842)**
- `.env.local` sourced → **1842 passed (1842)**, 59 files

⚠️ The skipped count moved from 321 to 345 since [0051](0051-the-run-gets-a-table.md).
That is not drift: the 24 agent tests added in `b2a61f7` are database-gated too.

PostgreSQL identified by **data directory**, not by which port answered
([0045](0045-a-preflight-that-lied.md)): `55432` → `~/.growth-os/pgdata`
(PID 11424), the project's. `55433` → `~/Desktop/AI`, unrelated.

## The boundary assumption was measured, not carried forward

The brief said guardrails "shouldn't need `@growth-os/net` — confirm that
assumption rather than carrying it forward". Confirmed by writing a `node:http`
import into the not-yet-existing package and running ESLint on it:

```
packages/guardrails/src/__measure_probe.ts
  1:1  error  Only @growth-os/net may open a socket … no-restricted-syntax
```

The global socket rule matches `packages/**/*.ts` with `ignores:
['packages/net/**']`, so a brand-new package is covered with **zero config
changes**. Nothing needed adding for the network half.

## ⚠️ The finding: the threshold is not a constant, it is a function of length

The plan was one number — a Jaccard similarity above which two drafts are
duplicates. Calibrating it against a 51-shingle marketing draft looked clean:

| Candidate                                       | Similarity |
| ----------------------------------------------- | ---------: |
| identical                                       |      1.000 |
| identical, repunctuated and recased             |      1.000 |
| the same prose split across different fields    |      0.925 |
| republished with one paragraph appended         |      0.721 |
| lightly reworded — synonym swaps, same skeleton |      0.384 |
| different topics sharing trade boilerplate      |      0.246 |
| heavily rewritten, same topic                   |      0.000 |
| unrelated                                       |      0.000 |

A clean gap between 0.246 and 0.384. 0.30 sits in it. Done — except that the
false-positive corpus was short drafts, and it was worth checking whether that
mattered before trusting the number.

**It mattered more than anything else measured.** Holding two genuinely
different topics constant, sharing one boilerplate sentence, growing the body:

| Words | Similarity |                                     |
| ----: | ---------: | ----------------------------------- |
|    20 |      0.714 | ⚠️ higher than a real republication |
|    25 |      0.484 | ⚠️ would falsely flag               |
|    30 |      0.366 | ⚠️ would falsely flag               |
|    35 |      0.294 | crossover                           |
|    40 |      0.246 |                                     |
|    50 |      0.185 |                                     |
|    80 |      0.113 |                                     |

At 20 words, two drafts about **different services** scored 0.714 — higher than
a genuine republication with a paragraph appended (0.721, barely). A shared
stock sentence is most of a short draft and almost none of a long one.

So a single threshold cannot be honest across lengths. The fix is a floor:
below `MIN_COMPARABLE_WORDS = 40` the check returns **`indeterminate`** rather
than a verdict.

### This corrects the brief

The brief specified "returns pass/fail plus reasons". Two values are not enough
— `pass` in the short-document regime would be a clearance the check did not
earn. `indeterminate` is a third outcome and is deliberately **not** `pass`; a
caller that collapses them has turned "I could not tell" into "I checked and it
is fine".

The uncomfortable consequence is kept rather than smoothed over: an _identical_
short draft also returns `indeterminate`. Being right by luck at a length where
the method is usually wrong is not a property worth shipping, and a test pins
that case so nobody quietly special-cases it later.

## Two real bugs the tests found

Neither was a wrong expectation; both were wrong code.

**The cap did not bound what it claimed to.** `extractText` counted collected
characters but joined the parts with spaces afterwards, so a 200,000-character
cap returned 200,199 characters. A cap that bounds an intermediate rather than
the returned value is not a cap. The separator now counts.

**NFKD mangled Japanese.** Folding accents by decomposing and stripping
`̀–ͯ` also splits `ビ` into `ヒ` + U+3099 — and U+3099 is not `\p{L}`,
so it became a word separator and cut `サービス` in half. `toWords` now
recomposes with NFKC after the strip, which keeps `café == cafe` and leaves
non-Latin scripts intact.

One test expectation _was_ wrong and is corrected in place with a note: the
shingles of `buy now buy now` at size 2 are `{buy now, now buy}` — two, not the
three I asserted.

## Mutation-tested, because 60 green tests prove nothing on their own

| Mutation                                    | Result           |
| ------------------------------------------- | ---------------- |
| `SIMILARITY_THRESHOLD` 0.30 → 0.50          | 1 test failed ✓  |
| `MIN_COMPARABLE_WORDS` 40 → 0               | 5 tests failed ✓ |
| cross-workspace `throw` → silent `continue` | 4 tests failed ✓ |
| published-only filter removed               | 2 tests failed ✓ |

Restored after each; 60 passed again at the end.

The fixtures **are** the calibration corpus, so these are not illustrations of
the constants — they are the measurements that produced them, pinned.

## Design calls worth recording

**The package is pure and is given its corpus.** It has zero dependencies,
opens no socket and imports no database. That is not tidiness: a pure check can
run _before_ the output is persisted, which is the only moment catching a
duplicate is still cheap. A check that queried `agent_outputs` itself could only
run after the row existed — cleanup, not prevention.

Enforced rather than asserted: a new ESLint block forbids `@growth-os/*` inside
`packages/guardrails`, and two probes in `verify-boundaries.mjs` prove both the
socket and database imports are rejected. **31 boundaries enforced, up from 29.**

**A cross-workspace prior throws.** Filtering it away quietly would turn a
tenancy bug into a check that merely finds nothing — which looks exactly like a
clean pass.

**Unpublished priors are excluded.** A rejected draft still sits in
`agent_outputs`; comparing against it would flag the _correction_ as a duplicate
of the thing it corrects, firing hardest precisely when a human had already done
the right thing.

**The other two checks are absent, not stubbed.** Platform ToS / rate limits and
disclosure compliance have no placeholder, because a stub returning `pass` is
indistinguishable from a check that works. A test asserts `PHASE_0_CHECKS` has
exactly one entry.

## Verification

- `npm run verify:all` — see the report; count stated there, not here.
- `npm run verify:boundaries` — 31 boundaries, including the two new ones.
- `package-lock.json` updated by `npm install` to register the new workspace;
  the diff is 8 lines and adds no dependency.

## Remaining work

1. **Nothing calls this.** Shaped by reasoning about a caller, not by one.
2. **A rewritten duplicate passes** — same argument, new sentences, 0.000. This
   catches republication and light editing, not paraphrase. Closing it needs
   embeddings, which need a model, which is not connected
   ([ADR-0064](../decisions/ADR-0064-self-duplication-guardrail.md) alternative C).
3. **Both constants were calibrated on invented English copy** — eight pairs and
   one sweep. The first real corpus should re-derive them.
4. **Short-form output gets no verdict at all.** Headlines, ad copy and subject
   lines are all under 40 words.
