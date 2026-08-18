# 0019 — The URL length ceiling, and two caps that bind on different inputs

**Date:** 2026-08-18 · **Stage:** 4

## Objective

Bound URL length in `normaliseUrl`, test-first. The highest-value fix that
[0018](0018-the-regex-sweep.md) found: it collapses a measured denial of service
and bounds two linear patterns as a side effect.

## Initial state

Verified, not recalled: `aea66ed`, tree clean, `verify:all` **882 passed / 208
skipped (1090)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0 behind.

## Investigation

### The baseline was re-measured, not inherited

0018's figures are a previous session's. §0 says verify. Re-measured here
against the same corpus (604,214 bytes, truncating to 255 rules):

| path length | 0018 recorded |    measured now |
| ----------- | ------------: | --------------: |
| 2,048       |         55 ms |         62.7 ms |
| 5,000       |     3,113 ms¹ |      4,660.8 ms |
| **10,000**  |     12,530 ms | **16,817.8 ms** |

¹ 0018 measured 4,000 rather than 5,000; the rows are adjacent, not identical.

Same order, this machine slower. The numbers below are all this session's.

### Two things the brief did not say, found before writing code

**`MAX_URL_LENGTH` was not exported.** `policy.ts` declared it as a bare
`const`, and `export * from './url/policy'` re-exports only exported symbols.
The brief says to use that constant and not invent a second number — which is
right, and required a one-word change to `@growth-os/net` first. Reported rather
than done silently (§3).

**`isAllowed` consumes the output, not the input.** `decide.ts:150` passes
`normalisedUrl`. That decides the whole design: an input cap bounds
`normaliseUrl`'s own work, and an **output** cap is what bounds the matcher. Two
caps doing two different jobs, not one cap written twice.

### Normalisation grows a URL — measured

`+` → `%20` in the query. A 2,018-character input produced 6,018 characters of
identity: **2.98×**. So an input-only cap would store values over the ceiling.

### ⚠️ And the database backstop is missing on the table this path writes to

Checked rather than assumed, because the ADR was about to claim it. Migration
0008: `crawl_pages.normalised_url` (line 272) and `site_pages.normalised_url`
(line 337) both carry `CHECK (… length("normalised_url") <= 2048)`.
**`crawl_frontier.normalised_url` (line 16) has none** — a bare `text NOT NULL`.

`enqueueDiscovered` writes to `crawl_frontier`. So on the exact path this brief
is about, nothing at any layer was stopping an over-length URL. §5 says limits
live in the database, and here the application check is doing work the database
is not backing up. Not fixed — a constraint is a migration with its own from-zero
probe (§7.2), and this brief was scoped to `normaliseUrl`. Named in remaining
work.

## Decisions

[ADR-0038](../decisions/ADR-0038-url-length-ceiling.md). A URL longer than
`MAX_URL_LENGTH` has no crawl identity; `normaliseUrl` returns `null`. Checked
before any work and again after normalising. The constant is imported from
`@growth-os/net`, never redeclared.

**`null`, not truncation**, and the ADR argues it at length because §5 makes URL
identity singular. A truncated URL is a different URL — one nobody linked, which
enqueues and fetches a page that may not exist, recorded under an identity the
site never served. That is the same defect class 0018 found in `normaliseQuery`,
where re-encoding collapsed five URLs into two identities. Truncating would have
fixed a denial of service by adding a second instance of the defect.

### Which cap binds, measured

Both, on disjoint inputs. Neither is redundant.

| input                              | in     | rejected by      |
| ---------------------------------- | ------ | ---------------- |
| 2,048 exactly                      | 2,048  | accepted         |
| 2,049                              | 2,049  | **input check**  |
| the 10,000-character path          | 10,000 | **input check**  |
| `?q=` + 1,000 `+`                  | 1,018  | **output check** |
| `./page` against a 2,116-char base | 6      | **output check** |

The input check fixes the denial of service. The output check keeps stored
identity inside the ceiling — including on `crawl_frontier`, which has no CHECK
of its own. The crossover for the `+` shape is 683 plus signs: an input at
**34 % of the ceiling** that exceeds it after normalising.

## ⚠️ The residual, and the decision about it

The brief asked for this explicitly rather than leaving it to be rediscovered.

**The cap does not make the matcher cheap. It makes it bounded.** At the ceiling
`isAllowed` still costs **60.9 ms per call**, sharply non-linear because the
hostile pattern's literal runs are 1,000 characters:

| path  |    per call |
| ----- | ----------: |
| 256   |      0.5 ms |
| 1,024 |      1.8 ms |
| 2,048 | **60.9 ms** |

`page_limit` is bounded by `CHECK BETWEEN 1 AND 10000` (migration 0008), and
`isAllowed` runs once per discovered URL. Aggregate worst case, hostile
robots.txt with every URL at the ceiling:

|        |       per crawl |
| ------ | --------------: |
| before |     ~46.7 hours |
| after  | **~10 minutes** |

**281×, and still a denial of service.** Accepted for now on three grounds: a
realistic 80-character path costs **0.20 ms** against the same corpus, so this is
an adversarial cost and not a normal one; nothing outside `packages/crawler`
calls this path yet; and the fix belongs to the matcher, which is the crawl
permission boundary, not to a brief about a length cap.

**Proposed, not implemented:** a step budget inside `matchesPattern` that fails
closed when exceeded — consistent with `parse.ts`'s own header, _"every ambiguity
below resolves toward not fetching."_ Own brief, own ADR, own hostile-input suite.

## Testing

**9 new tests**, `packages/crawler/src/urls/normalise.test.ts`. Suite **891
passed / 208 skipped**, against 882 before. Written before the implementation and
observed failing first — 6 failures, which is how two bugs in the tests were
caught rather than shipped.

The boundary: exactly at the cap, one over, an input under the cap that exceeds
it after normalising, a relative href against a long base, whitespace trimmed
before measuring, and a 500,000-character input rejected in under 50 ms to prove
the check runs before the work.

The property, asserted as a property: the 10,000-character path returns `null`,
so the matcher is never called with it — `decide.ts` returns at the identity step
before reaching the robots step. Then the matcher is timed at the ceiling against
the same 255-rule corpus the measurement came from.

### Two test bugs, recorded because both were mine

**The verdict assertion was wrong, and the reason is a separate defect.** I
asserted `allowed: true` for a path of `a`s against rules ending in `b`. It
returned `false`. Not the hostile rules: the 512,000-byte parse cap cuts the last
rule mid-pattern, leaving a 420-character `Disallow: /aaa…` with its `*` and
final `b` gone — and an unanchored pattern is a prefix match, so the stump
matches. That is 0018's truncation defect, arriving unbidden in a test written
for something else.

The assertion is now on `reason`, not on the boolean, with the cause recorded in
the test. Asserting a boolean governed by a known separate defect would make the
test fail when that defect is fixed, for a reason unrelated to what it covers.

**The base-resolution case did not test what it claimed.** A 2,000-character base
plus `./page` resolves to 2,020 characters — under the ceiling, so `null` was the
wrong expectation. The test now asserts both lengths explicitly, so the case
cannot silently stop exercising the boundary if the constant changes.

Both were caught only because the tests were run before the implementation
existed. A test written after the code, against code that already passes, would
have encoded both mistakes as expected behaviour.

## Files

```
packages/net/src/url/policy.ts                  MAX_URL_LENGTH exported
packages/crawler/src/urls/normalise.ts          the ceiling, checked twice
packages/crawler/src/urls/normalise.test.ts     9 tests
docs/decisions/ADR-0038-url-length-ceiling.md
docs/decisions/README.md                        index row
```

## Architecture impact

§5's "URL identity is singular" is preserved and tightened: the set of strings
with a crawl identity is now smaller, and one function still decides it. The
ceiling is the same number `admitUrl` enforces, imported rather than copied, so
the frontier cannot store a URL the fetcher will refuse.

Limits-live-in-the-database is **not** satisfied on this path, and the gap was
found while writing the ADR rather than assumed away: `crawl_pages` and
`site_pages` carry the CHECK, `crawl_frontier` does not. A constraint cannot be
the primary enforcement here — the cost this prevents is spent before any row is
written — but it is the right backstop and it is absent on the one table
`enqueueDiscovered` writes to.

## Security impact

A measured denial of service, reachable by any site that chooses to serve a
hostile robots.txt and link long URLs, is bounded from ~46.7 hours to ~10 minutes
per crawl. Latent rather than live: nothing outside `packages/crawler` calls this
path yet, which is what made the fix free to make now.

## Result

The expensive input cannot arrive. Rejecting a 10,000-character URL costs
**0.0009 ms**; evaluating it cost 16,817.8 ms.

## Remaining work

1. **The matcher step budget** — the residual above, 60.9 ms per call at the
   ceiling. The single next task.
2. The two robots fail-open defects from 0018: colon-less directives, and
   truncation flipping `Disallow` into `Allow`. One of them surfaced inside this
   session's tests.
3. **`crawl_frontier.normalised_url` has no length CHECK** while `crawl_pages`
   and `site_pages` do — §5, and it is the table this path writes to.
4. `url_too_long` as a `crawl_skip_reason` — an over-length URL is recorded as
   `unsupported_scheme` today. Needs a migration; fold it into the same one as
   (3), since both touch migration 0008's crawl tables.
5. The rest of 0018's ranked list, unchanged.
