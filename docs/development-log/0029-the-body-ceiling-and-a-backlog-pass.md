# 0029 — The body ceiling, a timing argument that survived, and 0018's backlog closed out

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Two things, and the second is the point of the session.

1. Reconcile `verification.ts`'s body-size limits with its own comment — the last
   item on 0018's ten-item list still carrying a live comment/code discrepancy.
2. A status pass over everything 0018's backlog has accumulated across dev logs
   0025–0028. **Report only.** 0018 set the precedent for exactly this kind of
   pass, and this one follows it.

## Initial state

Verified, not recalled: `7ebf8e5`, tree clean, `verify:all` exit 0 at **1113
passed / 230 skipped (1343)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Part 1 — the body ceiling

### Re-measured (§0/§1)

0018's line numbers hold exactly, four sessions later: `verification.ts:279`,
`fetch.ts:145`, and the merge at `fetch.ts:203`. ADR-0037 states the premise in
print — _"The caller accepts 1 MB bodies"_ — and that clause was never true after
decompression.

### ⚠️ ADR-0037's timing argument survives, which is the finding

The brief asked whether 8 MB changes the safety margin. **It does not.**
`findMetaTokens` on ADR-0037's own adversarial shape, extended past its table:

| input    | ADR-0037 | re-measured | ms/MB |
| -------- | -------- | ----------- | ----- |
| 70 KB    | 2 ms     | 2.0 ms      | 28.5  |
| 1.12 MB  | 14 ms    | 12.3 ms     | 11.0  |
| **8 MB** | —        | **96.4 ms** | 12.1  |
| 16 MB    | —        | 173.5 ms    | 10.8  |

Flat at ~11–12 ms/MB out to 16 MB. ADR-0037 replaced a quadratic regex with a
linear parse, and **linearity does not care where the ceiling sits** — so its
conclusion is unaffected by its wrong premise. There is no timing emergency here,
and saying so plainly is the result (§1).

### What is actually wrong is the ratio

| caller                     | compressed | decompressed | expansion |
| -------------------------- | ---------- | ------------ | --------- |
| `DEFAULT_LIMITS`           | 2 MB       | 8 MB         | **4×**    |
| `robots/fetch.ts:126`      | ceiling    | ceiling × 4  | **4×**    |
| `verification.ts` (before) | 1 MB       | 8 MB         | **8×**    |

Verification is the call site that deliberately asked to be _tighter_ and ended
up permitting _twice the expansion_. Nobody chose 8×; it is what arrives when
half a decision is written down. Measured, 8 MB of ordinary markup gzips to
**24 KB** — so the ratio is what an origin actually spends, and the compressed
cap never comes near firing.

### The decision, and neither option the brief offered

The brief framed it as comment-wrong or code-wrong. Measurement says neither: the
comment is not false, it annotates `maxCompressedBytes` and that value _is_ 1 MB
— it is incomplete. And capping decompressed at 1 MB is a change nothing measured
asks for, which §1 warns against.

Both tiers are now stated at the call site, at the default's 4× ratio:
`maxDecompressedBytes: 4 * 1024 * 1024`. **4 MB is derived** — the ratio
`DEFAULT_LIMITS` and `robots/fetch.ts` already use — not a new opinion.

⚠️ **This is a tightening with no measured defect behind it**, and that is stated
in ADR-0048 rather than buried. Pages decompressing to between 4 MB and 8 MB
verified before and do not now.

### Testing

**4 new tests.** ⚠️ Every oversized page in them **carries a valid tag**: if the
cap fails to fire, the parser reaches the tag and verification _succeeds_, so
`verified: false` proves the limit stopped the body rather than that some error
came back.

**1 of 4 observed red**, and that is fewer than the count suggests. The 8 MB case
fires against an 8 MB ceiling too, so it is a control. Only "the enforced ceiling
is 4 MB, not the 8 MB it used to inherit" distinguishes the change — it is the
assertion that fails if the explicit `maxDecompressedBytes` is ever dropped. The
other three pass in both states by design.

## Part 2 — the backlog status pass

Six items carried across 0025–0028. Each re-measured this session, not recalled.

| #   | item                                                               | status                    | measured                                                                                                                                    | close here?                       |
| --- | ------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `fieldKey` / `customFieldKey` unbounded quantifier behind `.max()` | **Still applies**         | Regex runs on the full 200,000 chars despite `.max(48)`. Cost **linear**: 3.82 ms at 6.4 MB, 3.97× per 4× size                              | Own brief — but a small one       |
| 2   | `publicSubmissionSchema` unbounded key count                       | **Smaller than recorded** | Route caps the body at **32 KB before parsing**; densest legal payload is **3,384 keys in 3.20 ms**, not the 100,000 in 52 ms 0027 recorded | Arguably close as won't-fix       |
| 3   | threat-model T12 scoped to Stage 7                                 | **Still applies**         | `threat-model.md:184` still reads "(Stage 7)" and still omits form-submitted context                                                        | Own brief (docs, one paragraph)   |
| 4   | `referrerHost` / `normaliseWebsiteHost` byte-identical             | **Still applies**         | Both are now 6 identical lines over `httpUrlOf`, in different packages                                                                      | Own brief — or deliberately never |
| 5   | `splitLandingUrl` dead                                             | **Still applies**         | Only references are its definition and two test files                                                                                       | Own brief — or deliberately never |
| 6   | local dev database at migration 0007                               | **Still applies**         | 8 of 10 migrations applied; `0008_website_crawler` and `0009_frontier_url_check_and_skip_reasons` never applied locally                     | Not a code change at all          |

### ⚠️ Item 2 is materially smaller than 0027 recorded it

0027 measured the schema in isolation and reported 100,000 keys parsing in 52 ms.
This session measured the **route**, which checks `MAX_BODY_BYTES = 32 * 1024`
against `Content-Length` _and_ the raw body **before** `request.json()` — the
route's own docstring says why. The densest legal payload that fits is 3,384 keys
at 3.20 ms.

The schema is still unbounded, and that is still true as written. But the finding
as recorded — an unbounded collection reachable from the public endpoint — is not
reachable. **0027 measured the wrong layer**, and this pass is the first time
anyone looked one level up. Worth naming, because it is the third time in five
sessions the record has needed correcting against a measurement.

### Two the project should decide about rather than carry

Items 4 and 5 have now been carried through four dev logs each with no change of
state, which is a sign they are not really pending work:

- **Item 4** is six duplicated lines in two packages that serve different domains.
  Collapsing them means one package importing the other's identity helper, or a
  third home for it. That may be worse than the duplication.
- **Item 5** is a function ADR-0044 deliberately kept, with tests, because
  deleting it would take the shape-check decision with it.

Neither is a defect. Both are honest to close as accepted rather than carry a
fifth time — but that is a call for the project, not for this session, and this
entry does not make it.

## Files

```
packages/sites/src/verification.ts        both tiers stated, 4 MB decompressed
packages/sites/src/verification.test.ts   4 tests
docs/decisions/ADR-0048-verification-body-ceiling.md
docs/development-log/0029-the-body-ceiling-and-a-backlog-pass.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Testing

`verify:all` exit 0: **1,117 passed / 230 skipped (1,347)**, against 1,113 / 230
(1,343) at the start. 29 boundary probes.

No migration was touched (0 files changed under `packages/database/migrations`),
so §7.2 has nothing to apply. The local dev database was read to establish item 6
and not written to.

## Result

**0018's original ten-item list is closed.** Items 1–9 are fixed or measured
away; item 10 (the client-side email regex) remains a deliberate last-priority
deferral, not an open discrepancy — it is client-side, on a value its own victim
types, in a file that documents itself as a courtesy.

The last item resolved into a negative result and a smaller real defect than the
one recorded: ADR-0037's timing argument was made on a false premise and is
correct anyway, and the thing worth fixing was not the 8 MB but the 8× ratio that
nobody chose.

⚠️ **The general version of that defect is untouched.** Every caller that
overrides one limit tier still inherits the other, and nothing stops the next one
acquiring a ratio it did not pick. Fixing that means changing the merge in
`fetch.ts`, which is the shared network boundary and needs its own brief and its
own measurement of the crawler and robots paths.

## Remaining work

Nothing from 0018 is on a live write path. What remains, in the order this
session would rank it:

1. **The `fetch.ts` limits merge** — the general form of what ADR-0048 fixed at
   one call site. New, from this session.
2. **`fieldKey` / `customFieldKey`** — two one-line quantifier bounds plus tests,
   the shape ADR-0046 fixed on `fieldTarget`. Linear cost, so not urgent.
3. **threat-model T12** — one paragraph, naming form-submitted context and that
   it is live before Stage 7.
4. **Items 4, 5 and 2** — propose closing as accepted rather than carrying a
   fifth time.
5. **The local dev database** — apply 0008 and 0009, or record that the crawl
   schema is deliberately test-harness-only until Stage 4 ships.
6. The client-side email regex, still last, still as a length guard.
