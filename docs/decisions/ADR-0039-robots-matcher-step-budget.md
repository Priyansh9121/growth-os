# ADR-0039 — A robots pattern that costs too much to evaluate is presumed to have matched

**Status:** Accepted
**Date:** 2026-08-18

## Context

[ADR-0038](ADR-0038-url-length-ceiling.md) bounded the crawler's URL length and
then named its own residual explicitly:

> **The cap does not make the matcher cheap. It makes it bounded.** … a step
> budget inside `matchesPattern` that fails closed when exceeded … **Proposed,
> not implemented here.**

This is that budget. Three of the numbers ADR-0038 and the brief for this work
carried forward turned out to be wrong, and each is corrected below by
measurement rather than argument.

### ⚠️ Correction 1 — the residual is 16 hours, not 10 minutes

ADR-0038 measured the corpus dev log 0018 had built: 300 rules of the shape
`/a×1000 * a×1000 b`, truncating to 255. It reported **60.9 ms** per `isAllowed`
call at the 2,048 ceiling, and a ~10-minute aggregate over `page_limit = 10000`.

**That corpus is not the worst one, and it is not close.** The cost of one
comparison is `backtracks × the literal run each backtrack re-compares`, so it
is maximised when the run is **half** the target's length, not the whole of it.
An exhaustive sweep over `/a^P * a^S b` at the ceiling:

| shape                             |     steps | ms       |
| --------------------------------- | --------: | -------- |
| `/a×1000 * a×1000 b` (ADR-0038's) |    49,049 | 0.296    |
| **`/* a×1023 b`** (the maximum)   | 1,049,601 | **7.02** |

`T²/4 = 1,048,576`, so the maximum is structural, not a lucky find. Packed into a
604 KB file the same way, and measured through the real module:

| corpus              | rules |     per call | per 10,000-URL crawl |
| ------------------- | ----: | -----------: | -------------------- |
| ADR-0038's          |   255 |        76 ms | 12.7 min             |
| `/*a^250 b`, 604 KB | 1,940 | **5,835 ms** | **16.2 hours**       |

The residual ADR-0038 accepted as "~10 minutes" was **16.2 hours**. Its
conclusion — that this needed its own brief — was right for a stronger reason
than it knew.

### ⚠️ Correction 2 — the budget must count steps, not backtracks

The brief specified counting "the operation that actually scales — the backtrack
retries, not the outer loop", and told us to measure first. Measured, against a
2,048-character target:

| pattern                          |  steps | backtracks |    ms |
| -------------------------------- | -----: | ---------: | ----: |
| `/a×1000 * a×1000 b` (expensive) | 49,049 |     **47** | 0.362 |
| `/(a*)×500 b` (harmless)         |  2,548 |  **1,547** | 0.022 |

**The harmless pattern has 33× more backtracks and costs 20× less.** Backtracks
are not merely a weaker proxy for cost, they are anti-correlated with it here, so
a backtrack budget would have refused the cheap input and passed the expensive
one. Loop steps track wall clock at a flat **~6 ns** across every shape measured,
including a pure literal and an all-star pattern. The budget counts steps.

The reason the brief's instinct failed is the same one dev log 0018 recorded
about itself: cost is `backtracks × run length`, and **neither factor alone is
the bill**.

### ⚠️ Correction 3 — a per-pattern budget alone cannot fix this

`isAllowed` evaluates every rule in the group, and `maxRules` is 2,000, so the
cost of answering one permission question is `rules × per-rule cost`. Capping
the per-rule cost at `B` leaves `2000 × B`:

| per-rule budget `B` | rules | per call | per crawl    |
| ------------------: | ----: | -------: | ------------ |
|               5,000 | 2,000 |  60.3 ms | 10.1 min     |
|              10,000 | 2,000 | 120.6 ms | **20.1 min** |
|              50,000 | 2,000 | 603.0 ms | 100.5 min    |

And `B` cannot go below ~10,000 without refusing real patterns (see the line
below). **So a per-pattern budget alone lands at 20 minutes per crawl — worse
than the residual it was meant to remove.** This was put to the author before
implementing, and the decision was to bound both.

## Decision

**Two budgets, both failing closed.**

```ts
export const DEFAULT_STEP_BUDGETS: RobotsStepBudgets = {
  perPattern: 50_000,
  perEvaluation: DEFAULT_ROBOTS_LIMITS.maxRules * MAX_URL_LENGTH, // 4,096,000
};
```

`matchPattern` returns **three outcomes**, not a boolean:

```ts
type PatternMatchOutcome = 'match' | 'no_match' | 'budget_exhausted';
```

### ⚠️ Where the line sits, and what is on each side of it

**`perPattern = 50,000.`** Measured, 94 real-world pattern shapes — WordPress,
WooCommerce, Shopify, Magento, Drupal, MediaWiki, news sites — against the
longest URL `normaliseUrl` will admit:

|                                                               | steps         |
| ------------------------------------------------------------- | ------------- |
| median real pattern, realistic URL                            | **5**         |
| worst real pattern, realistic URL                             | **92**        |
| worst real pattern, a 2,048-char URL of a realistic shape     | **2,235**     |
| worst real pattern, an adversarially-chosen 2,048-char target | **4,095**     |
| **the budget**                                                | **50,000**    |
| the pathological pattern at the same ceiling                  | **1,049,601** |

**12× above anything legitimate that could be measured, 21× below the payload it
exists to refuse.** The two populations are separated by 256×; the line is inside
that gap and not near either edge.

The structural reason legitimate patterns are cheap: cost is bounded by
`target × (the literal run re-compared on each retry)`, and real patterns' runs
are short words (`.pdf`, `/feed/`, `?replytocom=`) with no self-overlap, so most
retries fail on the first character.

**`perEvaluation = maxRules × MAX_URL_LENGTH = 4,096,000.`** ⚠️ **Derived, not
picked.** It is exactly what evaluating a maximally large robots.txt against a
maximum-length URL costs **when no pattern backtracks pathologically** — the work
the algorithm is supposed to do. Everything past it is blowup, which is the thing
being refused.

Measured against legitimate files at a realistically-shaped 2,048-character URL:

| rules in the file              | steps used | of the allowance |
| ------------------------------ | ---------: | ---------------: |
| 15                             |     10,436 |             0.3% |
| 94                             |     76,590 |             1.9% |
| 500                            |    409,939 |            10.0% |
| **2,000** (the `maxRules` cap) |  1,629,218 |        **39.8%** |

A legitimate file at the rule ceiling, against a URL at the length ceiling, uses
under 40 % of the allowance. Nothing plausible is refused.

`MAX_URL_LENGTH` is **imported from `@growth-os/net`, never restated**, for the
reason ADR-0038 gives: two numbers that must agree are how they stop agreeing.

### ⚠️ Fail closed, and asymmetrically — this is the permission decision

An exhausted budget is an ambiguity: we do not know whether the rule matched.
`parse.ts`'s header says every ambiguity resolves toward not fetching. So:

| the rule we could not evaluate | is presumed             | because                                          |
| ------------------------------ | ----------------------- | ------------------------------------------------ |
| `Disallow`                     | **to have matched**     | we may not fetch what we cannot prove is allowed |
| `Allow`                        | **not to have matched** | permission we did not compute is not permission  |

Both presumptions push the same way. Dropping an unevaluable `Allow` can only
ever make a verdict more restrictive, never less — which is what makes it safe to
add a cost control to a permission boundary at all, and it is asserted as a
property below rather than argued for.

### ⚠️ And precedence still runs — a presumed match does not short-circuit

The tempting implementation is to refuse immediately on the first exhausted
`Disallow`. **That is more restrictive than necessary, and unnecessarily so.**

A presumed match competes on length like any other rule. Consider a presumed
`Disallow` of effective length `L` and a genuine `Allow` of length `≥ L`:

- if the `Disallow` really matched → the longer `Allow` beats it → **allowed**
- if it really did not match → the `Allow` wins uncontested → **allowed**

**The answer is the same under both readings of the unknown**, so refusing there
would refuse a URL whose verdict is in fact known. Running precedence normally
refuses exactly when the two readings disagree — which is the definition of not
knowing, and the smallest set of refusals consistent with failing closed.

### The verdict stays reportable

`RobotsReason` gains **`budget_exhausted`** — a new value, not an overloaded one.
An operator seeing "we did not crawl this" would otherwise be told
`longest_match`, which asserts that a rule they wrote decided it. It did not; our
budget did. `rule` still quotes the pattern verbatim, because the fact being
reported is that _that line_ is the one which costs too much (AGENTS.md §5: a
fact, never a judgement — this records what happened, not that the file is bad).

### `matchesPattern` is renamed to `matchPattern`

Not tidying. A predicate-shaped name returning a three-valued string is a
truthiness trap that **type-checks while inverting the permission boundary**:
`if (!matchesPattern(...)) continue;` evaluates `!'no_match'` to `false`, so
every rule would be treated as matching. The rename makes any stale caller a
compile error instead.

## What this costs, measured through the shipped module

| worst case at the URL ceiling | before                    | after                  |          |
| ----------------------------- | ------------------------- | ---------------------- | -------- |
| one pattern                   | 1,049,601 steps / 7.02 ms | 50,001 steps / 0.33 ms | **21×**  |
| one `isAllowed` call          | **5,835 ms**              | **28.0 ms**            | **208×** |
| a 10,000-URL crawl            | **16.2 hours**            | **4.7 min**            | **208×** |

A realistic file against an ordinary URL costs **0.0019 ms** per call and returns
a byte-identical verdict to the unbudgeted matcher.

## ⚠️ The residual, again, and it is a different kind

**4.7 minutes is not zero, and the remaining factor is no longer backtracking.**
`maxRules × MAX_URL_LENGTH` is what it costs to compare 2,000 patterns against a
2,048-character string at all. The polynomial blowup is gone — what is left is
the linear size of the problem.

Reducing it further means lowering `maxRules`, lowering `MAX_URL_LENGTH`, or
moving robots evaluation off the request path. All three are decisions with their
own consequences and none belongs in this brief. Named, not hidden.

## Alternatives considered

**Count backtracks, as the brief specified.** Refuted by measurement above: 33×
more backtracks on the input that costs 20× less.

**Refuse immediately on the first exhausted `Disallow`.** Rejected: it refuses
URLs whose verdict is determined under both readings of the unknown. Failing
closed means refusing what you do not know, not refusing more than that.

**Presume an unevaluable `Allow` matched.** Rejected outright — it is the one
choice that could turn a refusal into a fetch, which is the failure this whole
module exists to prevent.

**Truncate the pattern instead of budgeting.** Rejected for the reason ADR-0038
rejected truncating a URL: a truncated pattern is a different pattern, and it
fails _open_ — dev log 0018 measured `Allow: /private-public-page` truncated to
`Allow: /private` opening a whole subtree.

**A per-pattern budget only, as briefed.** Measured at 20.1 min per crawl, worse
than the residual it was meant to remove. Corrected before implementing.

**Make `perEvaluation` a round number.** Rejected. Deriving it from `maxRules`
and `MAX_URL_LENGTH` states the reasoning in the expression and tracks both
limits if either changes.

## Consequences

### Positive

- The measured denial of service falls 208×, and what remains is linear rather
  than polynomial in the inputs an attacker controls.
- A cost control was added to a permission boundary with a proof, not a hope,
  that it cannot grant permission: asserted as a property over 6 files × 5 paths
  × 4 budget settings.
- The reason an operator sees distinguishes our limit from their rule.

### Negative

- A site whose robots.txt contains a genuinely pathological pattern has the URLs
  that pattern is expensive against refused. It is a fail-closed refusal and it
  is reported as one, but it is a behaviour change at the permission boundary.
- 4.7 minutes of worst-case blocked event loop per crawl remains.
- `crawl_skip_reason` is a Postgres ENUM, so `decide.ts` still records this as
  `robots_disallowed`. The precise reason lives in the `RobotsVerdict` and not in
  the frontier row — the same wart ADR-0038 recorded for `url_too_long`, and it
  should be folded into the same migration.

## Verification

**12 new tests** in `packages/crawler/src/robots/parse.test.ts`. Suite:
**903 passed / 208 skipped**, against 891 before. 29 boundary probes.

Both sides of the line are asserted, not described: every real-world pattern
shape is required to cost less than a tenth of the budget, and the pathological
one is required to exceed a million steps unbudgeted and be refused budgeted.

The property that matters is asserted as a property — for six robots files, five
paths and four budget settings including `{perPattern: 1, perEvaluation: 1}`,
**any URL the budgeted matcher permits must also be permitted by the unbudgeted
one.** A budget that could open a page is the only way this change could be a
security defect, and that is the shape of the test.

⚠️ **One existing test changed and it was supposed to.**
`normalise.test.ts` pinned `reason === 'longest_match'` for the hostile corpus at
the ceiling. That corpus is now decided by a presumed match, so it reports
`budget_exhausted`. The assertion was updated, not relaxed: it now also pins
`allowed: false`, so it constrains the fail-closed outcome where before it only
constrained that some rule had won.

## Related

- [ADR-0035](ADR-0035-robots-and-politeness.md) — fail closed on unreadable robots.txt
- [ADR-0038](ADR-0038-url-length-ceiling.md) — the URL ceiling, and the residual this ADR resolves
- [dev log 0018](../development-log/0018-the-regex-sweep.md) — where the cost was first measured
- [dev log 0020](../development-log/0020-the-step-budget.md) — this work
