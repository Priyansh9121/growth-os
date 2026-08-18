# 0021 — The fail-open defects, a third one found while measuring, and a property that cannot exist

**Date:** 2026-08-18 · **Stage:** 4

## Objective

Fix both robots.txt fail-open defects from dev log 0018, test-first, in one
slice. They were the last two findings from that audit that made the crawler
_less_ restrictive rather than more.

## Initial state

Verified, not recalled: `02d9ffc`, tree clean, `verify:all` exit 0 at **903
passed / 208 skipped (1111)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Investigation

Both defects reproduced through the real module before anything was written. The
parser at `HEAD` was frozen to a scratch copy so every claim below is a
differential against shipped code rather than an argument about it.

### Defect 1 reproduced, exactly as 0018 recorded

| robots.txt                           | groups | `/admin/customers`              |
| ------------------------------------ | -----: | ------------------------------- |
| `User-agent: *` / `Disallow: /admin` |      1 | refused, `longest_match`        |
| `User-agent: *` / `Disallow /admin`  |      1 | **FETCHED**, `no_rule_matched`  |
| `User-agent *` / `Disallow /admin`   |  **0** | **FETCHED**, `no_group_matched` |
| `User-agent\t*` / `Disallow\t/admin` |  **0** | **FETCHED**                     |

### Defect 2 reproduced, after a fixture that missed

The first fixture put the cut inside `Disallow` on line 2 rather than inside the
final `Allow`, and produced an empty rule list — a real result, but not the
defect. Recomputed so the cut lands exactly at `Allow: /private`:

| rules              | parsed                                              |
| ------------------ | --------------------------------------------------- |
| untruncated        | `Disallow: /private`, `Allow: /private-public-page` |
| truncated (before) | `Disallow: /private`, **`Allow: /private`**         |

`/private` and `/private/secret-invoices`: refused untruncated, **ALLOWED**
truncated.

### ⚠️ The brief's premise is false, and no implementation can make it true

The brief said both fixes _"make the crawler fetch strictly less"_ and required a
property test proving neither _"can permit a URL that was previously refused"_.

A differential over generated files × paths said otherwise. **The first version
of that generator said the opposite** — 15,552 verdicts, 1,848 newly refused,
**zero** newly permitted — and it was wrong: it used one flag for the separator
on _both_ `User-agent` lines, so it could not construct a file where a
colon-less `User-agent` introduces a group alongside a colon-bearing one. That
is the entire failure mode.

Varying every line's separator independently, 62,208 verdicts:

|                   |  verdicts |
| ----------------- | --------: |
| unchanged         |    53,616 |
| now refused       |     7,206 |
| **now permitted** | **1,386** |

The archetype, run directly:

```
User-agent: *
Disallow: /
User-agent GrowthOSBot     ← invisible to the old parser
Disallow: /admin
```

`/foo`: **refused before, allowed after.** Before, the colon-less line was
skipped and `Disallow: /admin` joined the wildcard group, so `Disallow: /`
refused everything. Read correctly there are two groups, one names us, and RFC
9309 says the most specific group applies _and only that one_.

Defect 2 is non-monotone in the other direction, for the mirror reason: a
truncated `Disallow: /private-public-page` becomes `Disallow: /private` and
**over**-refuses, so declining to fabricate it permits more. Swept across every
cut offset: 1,537 unchanged, 16 newly refused, **107 newly permitted**.

⚠️ My own generator being wrong in the direction that flattered the brief is the
second time in three sessions that a measurement instrument had the defect it
was hunting — dev log 0018 recorded the same thing about its regex lexer. A
differential that reports zero regressions deserves the same suspicion as one
that reports many.

### ⚠️ Defect 3, found while explaining the counterexamples

Not in 0018, not in the brief. A file with **a colon on every line**:

| robots.txt                                                          | groups | `/admin/customers` |
| ------------------------------------------------------------------- | -----: | ------------------ |
| `User-agent: *` / `Allow: /` / `User-agent: *` / `Disallow: /admin` |      2 | **ALLOWED**        |
| the same two rules, swapped                                         |      2 | refused            |

`selectGroup` returned the **first** group naming the token, so the second was
discarded. RFC 9309 §2.2.1 requires records of groups with the same user-agent to
be combined. **The verdict depended on which duplicate came first** — a
permission boundary answering by file order.

It is entangled with defect 1: recognising colon-less `User-agent` lines creates
more groups and so more duplicates. Measured, defect 1's fix alone ships 1,386
refused→allowed verdicts through this path.

Stopped and put the scope question to the author with the numbers (§3), rather
than either silently expanding the brief or silently shipping a fail-open
regression inside a fail-open fix. Decision: fix all three.

Merging does not restore monotonicity either — it cannot, because merging can
bring an `Allow` into the applicable set:
`User-agent: * / Disallow: / / User-agent: * / Allow: /` merges to a tie, and
Allow wins ties. **"Refuses more" is simply not a property that "parses the file
correctly" has.**

## What was decided

1. **The colon wins wherever it appears; whitespace is a fallback, and only when
   the line is exactly two tokens.** Whitespace-first would break
   `Disallow : /admin`, which parses correctly today — a fail-open introduced by
   the fail-open fix. The two-token restriction is Google's, and without it
   `Disallow the admin area please` becomes a rule.
2. **A truncated body discards its final partial line.** Not a rejection —
   ADR-0035's "truncation is not permission" is untouched. We stop inventing the
   one rule we did not finish reading.
3. **`selectGroup` combines every group naming the winning token**, with
   `Crawl-delay` merging to the **maximum**, because ADR-0035 says a crawl delay
   may only ever slow us down and file order must not decide how hard we hit
   someone's server.

Where RFC 9309 and Google's parser disagree, this file now follows **whichever
refuses more**, and says so in one place. `maxBytes` was already justified in-file
as Google's ceiling, "the least surprising choice for a site owner who tested
against Google"; this is that argument applied where the surprise would be us
fetching their admin panel.

## The properties that replaced the impossible one

Three that are true, strong, and all fail against the old parser:

1. **No cut, at any offset, ever invents a rule.** Five files, every truncation
   point: the rules parsed are a **subset** of the untruncated file's rules.
2. **The verdict does not depend on which duplicate group comes first.**
3. **A legitimate file is untouched.** Over the 432 corpus files that use a colon
   on every line and repeat no agent — **2,592 verdicts, every one identical**.

## Result, measured through the shipped module

62,208 verdicts against the previous parser:

|               |  verdicts |
| ------------- | --------: |
| unchanged     |    53,408 |
| now refused   | **7,758** |
| now permitted | **1,042** |

The 1,042, attributed:

| cause                                                        | verdicts |
| ------------------------------------------------------------ | -------: |
| a colon-less `User-agent` line naming us becomes visible     |  **776** |
| repeated groups merge and the merged set contains an `Allow` |  **266** |

Both are the parser honouring a group it previously could not apply. Pinned by a
committed test so a later reader cannot mistake either for a regression.

## Testing

**22 new tests** in `packages/crawler/src/robots/parse.test.ts`. `verify:all`
exit 0: **925 passed / 208 skipped (1133)**, against 903 / 208 (1111) at the
start. 29 boundary probes.

**10 tests were observed red on the unmodified parser** before any fix was
written, covering all three defects, and green after.

⚠️ **One existing assertion changed, and it is the fix landing.**
`normalise.test.ts` pinned the hostile corpus at **255** rules; it is now 254.
The 255th was never a rule — it was the stump the byte cap fabricated. ADR-0038
named it as the truncation defect awaiting its own brief and deliberately left
that test's verdict unasserted because of it. Both comments updated to record
that the refusal now comes from the hostile rules themselves.

All differential probes were throwaway, ran against a frozen copy of the parser
at `02d9ffc`, and were deleted before commit. Committed fixtures are synthetic
and reach no network.

## Files

```
packages/crawler/src/robots/parse.ts          splitDirective, partial-line drop, group merging
packages/crawler/src/robots/parse.test.ts     22 tests
packages/crawler/src/urls/normalise.test.ts   255 -> 254, and why
docs/decisions/ADR-0040-robots-fail-open-defects.md
docs/development-log/0021-the-fail-open-defects.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Remaining work

Dev log 0018's ranked list, with items 1–3 now closed:

1. **Query re-encoding collapses URL identity** — §5, and it keys the durable
   `site_pages` index, so it is permanent once written. The highest-ranked open
   item.
2. **The `crawl_frontier` CHECK, `url_too_long` and `budget_exhausted`** — one
   migration, three things that need it.
3. `neutraliseCsvFormula` documented as a live control with no callers.
4. `fieldTarget` has no `.max()`.
5. Four `/^https?:\/\//i` copies disagree.
6. The CRM LIKE escaper misses `\`, affecting `countTracesOf`.
7. `verification.ts` inherits an 8 MB body cap where its comment says 1 MB.
8. The client-side email regex, as a length guard.
