# 0020 — The step budget, and three numbers the brief had wrong

**Date:** 2026-08-18 · **Stage:** 4

## Objective

Bound the cost of the robots pattern matcher with a step budget that fails
closed, test-first. The residual [ADR-0038](../decisions/ADR-0038-url-length-ceiling.md)
proposed and deliberately did not implement.

## Initial state

Verified, not recalled: `638091a`, tree clean, `verify:all` exit 0 at **891
passed / 208 skipped (1099)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Investigation

The brief carried three numbers forward from ADR-0038 and its own reasoning.
Measurement contradicted all three, and the third changed what got built.

### The instrument, validated first

An instrumented copy of `matchesPattern` — same algorithm, plus counters for
loop steps, backtracks, literal compares and star entries. Proven equivalent to
the real function before any number from it was trusted: **0 disagreements over
31 hand-written vectors and 200,000 randomised cases.**

Then the harness itself was validated against a known answer, the way
[0018](0018-the-regex-sweep.md) validated its own: the ADR-0038 corpus was
rebuilt and came out at **604,214 bytes parsing to 255 rules** — byte for byte
and rule for rule what that ADR recorded. It measured **77.3 ms** where ADR-0038
recorded 60.9 ms; same order, machine variance, close enough to trust the rig.

### ⚠️ Correction 1 — the counter the brief specified is anti-correlated with cost

The brief said to count "the backtrack retries, not the outer loop", and to
measure which dominates first. Against a 2,048-character target:

| pattern                          |  steps | backtracks |    ms |
| -------------------------------- | -----: | ---------: | ----: |
| `/a×1000 * a×1000 b` (expensive) | 49,049 |     **47** | 0.362 |
| `/(a*)×500 b` (harmless)         |  2,548 |  **1,547** | 0.022 |

**33× more backtracks on the input that costs 20× less.** A backtrack budget
would have refused the cheap pattern and passed the expensive one — the exact
inversion of what it is for.

Loop steps, by contrast, track wall clock at a flat **~6 ns per step** across
every shape measured — the expensive one, the harmless one, a pure literal, an
all-star pattern. The cost is `backtracks × the literal run each retry
re-compares`, and dev log 0018 had already written the lesson down: **neither
factor alone is the bill.**

### ⚠️ Correction 2 — the payload ADR-0038 measured is 21× off the worst one

0018 found that the expensive shape is long literal runs either side of one star,
and built its corpus with runs of 1,000 against a 2,048-character target. But
cost is `run × (target − run)`, maximised when the run is **half** the target —
so 1,000/1,000 is past the peak, and steeply.

An exhaustive sweep over `/a^P * a^S b` at the ceiling found the maximum at
`P=0, S=1023`:

| shape                             |     steps |       ms |
| --------------------------------- | --------: | -------: |
| `/a×1000 * a×1000 b` (ADR-0038's) |    49,049 |    0.296 |
| **`/* a×1023 b`**                 | 1,049,601 | **7.02** |

`T²/4 = 1,048,576`, so this is the structural maximum rather than a lucky find.
Packed into a 604 KB file the same way and run through the real module:
**5,835 ms per `isAllowed` call**, and over `page_limit = 10000`, **16.2 hours
per crawl**.

⚠️ ADR-0038 accepted its residual as "~10 minutes, and still a denial of
service". It was **16.2 hours**. That ADR's judgement — that this needed its own
brief — was right for a much stronger reason than it had.

This is 0018's own lesson landing a second time, one ADR later: **a measurement
only refutes the hypothesis you chose an input for.** 0018 chose its input from
the defending comment and got 0.22 ms. ADR-0038 chose its input from 0018 and
got 60.9 ms. Both were the wrong number, arrived at honestly.

### ⚠️ Correction 3 — the briefed scope cannot reach the brief's goal

`isAllowed` runs the matcher over every rule in the group and `maxRules` is
2,000, so the cost of one permission question is `rules × per-rule cost`. A
per-pattern budget `B` therefore leaves `2000 × B`:

| `B`    | rules | per call | per crawl    |
| ------ | ----: | -------: | ------------ |
| 5,000  | 2,000 |  60.3 ms | 10.1 min     |
| 10,000 | 2,000 | 120.6 ms | **20.1 min** |
| 50,000 | 2,000 | 603.0 ms | 100.5 min    |

And `B` cannot go below ~10,000 without refusing real patterns. **So the briefed
change lands at 20 minutes per crawl — worse than the ~10 minutes the brief was
written to remove.**

Stopped here and put it to the author with the numbers rather than deciding it
alone (AGENTS.md §3), because the alternative — one allowance shared across the
rule loop — changes the permission boundary in a way the brief had not stated.
Decision: bound both.

### The line, and both sides of it

94 real-world pattern shapes (WordPress, WooCommerce, Shopify, Magento, Drupal,
MediaWiki, news sites), measured against the longest URL `normaliseUrl` admits —
already adversarial for a real site, whose own URLs are two orders shorter:

| population                                                    | steps         |
| ------------------------------------------------------------- | ------------- |
| median real pattern, realistic URL                            | **5**         |
| worst real pattern, realistic URL                             | **92**        |
| worst real pattern, a realistic 2,048-char URL                | **2,235**     |
| worst real pattern, an adversarially-chosen 2,048-char target | **4,095**     |
| **`perPattern` budget**                                       | **50,000**    |
| the pathological pattern at the same ceiling                  | **1,049,601** |

The two populations are 256× apart. The line is inside the gap and near neither
edge — 12× above anything legitimate, 21× below the thing it refuses.

⚠️ **The second budget was derived rather than picked.**
`perEvaluation = maxRules × MAX_URL_LENGTH = 4,096,000` is what comparing 2,000
patterns against a 2,048-character string costs _when nothing backtracks
pathologically_. Legitimate files measured against it, at a realistically-shaped
2,048-character URL:

| rules in the file              | steps used | of the allowance |
| ------------------------------ | ---------: | ---------------: |
| 94                             |     76,590 |             1.9% |
| 500                            |    409,939 |            10.0% |
| **2,000** (the `maxRules` cap) |  1,629,218 |        **39.8%** |

A first candidate of 500,000 was discarded on this measurement: it looked fine
against synthetic `aaaa…` targets and would have **falsely refused a legitimate
500-rule file** against a realistically-shaped long URL. The synthetic target was
flattering the number.

## The permission decision

A budget exhaustion is an ambiguity, and `parse.ts` resolves every ambiguity
toward not fetching. Applied asymmetrically:

- an unevaluable **`Disallow`** is presumed **to have matched** — we may not
  fetch what we cannot prove is allowed;
- an unevaluable **`Allow`** is presumed **not to have matched** — permission we
  did not compute is not permission.

Both push the same way, so dropping an `Allow` can only ever make a verdict more
restrictive.

⚠️ **And precedence still runs.** The obvious implementation refuses immediately
on the first exhausted `Disallow`. That is more restrictive than necessary: a
presumed `Disallow` of length `L` against a genuine `Allow` of length `≥ L`
yields **allowed under both readings of the unknown**, so refusing there refuses
a URL whose verdict is known. Letting the presumed match compete on length
normally refuses exactly when the two readings disagree.

`matchesPattern` became `matchPattern` returning `'match' | 'no_match' |
'budget_exhausted'`. The rename is not tidying: a predicate-shaped name returning
a three-valued string **type-checks while inverting the boundary** —
`!'no_match'` is `false`, so `if (!matchesPattern(...)) continue;` would treat
every rule as matching.

## Result, measured through the shipped module

| worst case at the URL ceiling | before                    | after                  |          |
| ----------------------------- | ------------------------- | ---------------------- | -------- |
| one pattern                   | 1,049,601 steps / 7.02 ms | 50,001 steps / 0.33 ms | **21×**  |
| one `isAllowed` call          | **5,835 ms**              | **28.0 ms**            | **208×** |
| a 10,000-URL crawl            | **16.2 hours**            | **4.7 min**            | **208×** |

A realistic file against an ordinary URL costs 0.0019 ms and returns a verdict
byte-identical to the unbudgeted matcher.

⚠️ **4.7 minutes is not zero, and it is a different kind of residual.** The
polynomial blowup is gone; what remains is `maxRules × MAX_URL_LENGTH` — the
linear cost of comparing 2,000 patterns against a 2,048-character string at all.
Reducing it further means changing one of those two limits or moving robots
evaluation off the request path.

## Testing

**12 new tests** in `packages/crawler/src/robots/parse.test.ts`. `verify:all`
exit 0: **903 passed / 208 skipped (1111)**, against 891 / 208 (1099) at the
start. 29 boundary probes.

Both sides of the line are asserted rather than described — every real-world
pattern must cost under a tenth of the budget; the pathological one must exceed a
million steps unbudgeted and be refused budgeted.

The strong property (§6): for 6 robots files × 5 paths × 4 budget settings,
including `{perPattern: 1, perEvaluation: 1}`, **any URL the budgeted matcher
permits must also be permitted by the unbudgeted one.** A cost control that could
turn a refusal into a fetch is the only way this change could be a security
defect, so that is the shape of the test rather than a timing assertion.

⚠️ **One existing test changed, and it was supposed to.**
`normalise.test.ts` pinned `reason === 'longest_match'` for the hostile corpus at
the ceiling; that corpus is now decided by a presumed match and reports
`budget_exhausted`. Updated, not relaxed — it now also pins `allowed: false`, so
it constrains the fail-closed outcome where before it constrained only that some
rule had won.

All timing probes were throwaway and live in the session scratchpad. Fixtures in
the committed tests are synthetic and reach no network.

## Files

```
packages/crawler/src/robots/parse.ts             the two budgets, three-valued matcher, fail-closed evaluation
packages/crawler/src/robots/parse.test.ts        12 tests
packages/crawler/src/urls/normalise.test.ts      one assertion updated, and why
docs/decisions/ADR-0039-robots-matcher-step-budget.md
docs/development-log/0020-the-step-budget.md     this entry
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Remaining work

Unchanged from 0018's ranked list except that item 1 is now closed. Next:

1. **Robots colon-less directives fail open** — crawl admission, fetches what a
   site owner told Google not to.
2. **Robots truncation flips Disallow to Allow** — crawl admission; the
   `truncated` flag exists and nothing fails closed on it.
3. **The `crawl_frontier` CHECK and a precise skip reason** — one migration.
   `budget_exhausted` joins `url_too_long` as a reason the frontier row cannot
   currently express, so both should land with that enum change.
4. Everything else in 0018's list, in its order.
