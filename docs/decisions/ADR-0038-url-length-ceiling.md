# ADR-0038 — A URL longer than the admission ceiling has no crawl identity

**Status:** Accepted
**Date:** 2026-08-18

## Context

`normaliseUrl` enforced no length bound. It accepted a 100,000-character URL and
returned a 100,000-character identity.

The regex sweep ([dev log 0018](../development-log/0018-the-regex-sweep.md))
measured what that costs. The robots pattern matcher is
`O(rules × pattern × target)` — documented accurately and never multiplied out —
and `target` is the normalised URL. Measured in this session against the corpus
from that sweep (a 604,214-byte robots.txt truncating to 255 rules of the shape
`/aaa…*aaa…b`):

| path length |     `isAllowed` |
| ----------- | --------------: |
| 2,048       |         62.7 ms |
| 5,000       |      4,660.8 ms |
| **10,000**  | **16,817.8 ms** |

Both inputs are chosen by the same party. The robots.txt is fetched from the
site being crawled; the path is discovered on that site's pages. A site can
serve a hostile robots.txt and link long URLs, and it does not need to be
compromised to do so — it only needs to want to.

`MAX_URL_LENGTH = 2048` already existed in `@growth-os/net`
(`url/policy.ts`), enforced by `admitUrl` — **three steps too late.** The
sequence for a discovered link was: normalise (uncapped) → scope → robots
(the expensive call) → write the frontier row → and only at fetch time,
`admitUrl` rejects it as `url_too_long`.

## Decision

**A URL longer than `MAX_URL_LENGTH` has no crawl identity. `normaliseUrl`
returns `null`.**

The constant is **imported from `@growth-os/net`, never redeclared.** It was a
bare `const`; this ADR ships the one-word change that exports it. A second
number that must equal the first is how the two stop being equal, and the
failure mode is silent: a frontier row the fetcher will always refuse.

### Two checks, and they bind on different inputs

**Before any work,** on the trimmed input — because the cost is incurred
_producing_ the identity, not holding it. Capping only the result would leave
every bill already paid.

**After normalising,** on the result — because **normalisation can grow a URL.**
`+` becomes `%20` in the query, measured at **2.98×**.

Measured attribution, by input class:

| input                              | in     | rejected by      |
| ---------------------------------- | ------ | ---------------- |
| 2,048 exactly                      | 2,048  | accepted         |
| 2,049                              | 2,049  | **input check**  |
| the 10,000-character path          | 10,000 | **input check**  |
| `?q=` + 1,000 `+`                  | 1,018  | **output check** |
| `./page` against a 2,116-char base | 6      | **output check** |

Neither check is redundant. The **input check is what fixes the denial of
service**; the **output check is what keeps stored identity inside the ceiling**.
The crossover is at 683 plus signs, so an input at **34 % of the ceiling** can
exceed it after normalising.

⚠️ **And the backstop is missing on the one table this path writes to.**
Verified in migration 0008: `crawl_pages.normalised_url` (line 272) and
`site_pages.normalised_url` (line 337) both carry
`CHECK ("normalised_url" <> '' AND length("normalised_url") <= 2048)`.
`crawl_frontier.normalised_url` (line 16) is a bare `text NOT NULL` with no such
constraint — and `enqueueDiscovered` writes to `crawl_frontier`.

So until this change, an over-length URL had nothing stopping it at any layer on
the frontier path. §5 says limits live in the database; here the application
check is doing work the database is not backing up. Recorded rather than fixed:
adding the constraint is a migration, which carries its own from-zero probe
(§7.2) and is not what this brief was scoped to. Named in remaining work.

### ⚠️ `null`, not truncation

This is a change to URL identity, which §5 makes singular, so the alternative
has to be stated rather than assumed.

**A truncated URL is a different URL.** `/search?q=<2100 chars>` cut to 2,048 is
not that page; it is a URL nobody linked, which may 404, may return unrelated
content, and will be recorded under an identity the site never served. Worse, it
is _plausible_ — it parses, it is in scope, it enqueues, and it is
indistinguishable downstream from a page that really exists.

That is the same defect class the sweep found in `normaliseQuery`, where
re-encoding collapsed five distinct URLs into two identities and the crawler
fetched a URL the site never linked. Truncating here would add a second instance
of the defect while fixing a denial of service.

`null` already means "not a crawlable resource" — a `mailto:`, a `javascript:`,
a bare fragment. "Longer than anything we will ever fetch" belongs in that set.
The docstring's existing promise, _"never a repaired guess"_, is the whole
argument: a truncation is a repaired guess.

### What is lost

A real page at a URL over 2,048 characters is now invisible to the crawler
rather than enqueued-then-refused. Nothing is lost that was ever fetched:
`admitUrl` already refused these, so the change moves the refusal earlier and
stops writing a row that could only fail.

## ⚠️ The residual, measured and accepted for now

**The cap does not make the matcher cheap. It makes it bounded.**

At the ceiling, against the same hostile corpus, `isAllowed` still costs
**60.9 ms per call**, and the cost is sharply non-linear in path length because
the hostile pattern's literal runs are 1,000 characters:

| path  |    per call |
| ----- | ----------: |
| 256   |      0.5 ms |
| 512   |      1.1 ms |
| 1,024 |      1.8 ms |
| 2,048 | **60.9 ms** |

`isAllowed` runs once per discovered URL, and `page_limit` is bounded by
`CHECK ("page_limit" BETWEEN 1 AND 10000)` (migration 0008). So the aggregate
worst case — a hostile robots.txt where every discovered URL sits at the
ceiling:

|                    |       per crawl |
| ------------------ | --------------: |
| before this change |     ~46.7 hours |
| after this change  | **~10 minutes** |

A **281× reduction, and still a denial of service.** Ten minutes of blocked,
single-threaded event loop is not acceptable indefinitely.

**It is accepted now, for three reasons.** A realistic path — 80 characters —
costs **0.20 ms** against that same corpus, so this is an adversarial cost and
not a normal one. Nothing outside `packages/crawler` calls this path yet, so the
exposure is latent. And the alternative is to change the matcher, which is the
crawl permission boundary, in a brief whose subject is a length cap.

**Proposed, not implemented here:** a step budget inside `matchesPattern` that
fails closed when exceeded — consistent with `parse.ts`'s own header, _"every
ambiguity below resolves toward not fetching."_ That bounds cost per call
regardless of pattern shape, and it changes what the crawler is permitted to
fetch, so it needs its own brief, its own ADR and its own hostile-input suite.

## Alternatives considered

**Truncate to the ceiling.** Rejected above: a truncated URL is a different URL.

**Cap only the input.** Cheaper and insufficient — measured, a 1,018-character
input produces 3,018 characters of identity, over the ceiling and over the CHECK
that `crawl_pages` and `site_pages` do carry.

**Cap only the output.** Fixes what is stored and not what it costs. The matcher
runs on the output, so the expensive call would still happen; the row would be
discarded after the bill was paid.

**Declare a separate constant in `packages/crawler`.** Rejected explicitly by
the invariant it would break. Two limits that must agree is how they stop
agreeing, and `admitUrl` refusing what the frontier stored is invisible until a
crawl silently under-reports.

**Enforce it in the database instead** (§5, limits live in the database). A
constraint cannot be the primary enforcement here: the cost being prevented is
spent _before_ any row is written, so it would reject the row after the 16.8
seconds had already elapsed. It is the right backstop, and on `crawl_frontier`
it does not currently exist — see above.

**Add a `url_too_long` skip reason.** `crawl_skip_reason` is a Postgres ENUM
(migration 0008), so a precise reason costs a migration. Today an over-length URL
is recorded as `unsupported_scheme`, which is imprecise — it is the label every
`normaliseUrl → null` gets. Recorded as a known wart; not worth a migration on
its own, and worth folding into the next migration that touches this enum.

## Consequences

### Positive

- The measured denial of service is bounded: 16,817.8 ms → the expensive input
  never reaches the matcher, at a rejection cost of **0.0009 ms**.
- Stored identity is inside the column CHECK by construction, not by hope.
- `normaliseUrl` and `admitUrl` cannot disagree about how long a URL may be.

### Negative

- A page at a URL over 2,048 characters is not crawled. It was never fetchable.
- The residual above: still 60.9 ms per call at the ceiling, ~10 minutes
  aggregate worst case, needing its own brief.
- The skip reason is imprecise until the enum gains a value.

## Verification

**9 new tests**, all in `packages/crawler/src/urls/normalise.test.ts`. Suite:
**891 passed / 208 skipped**, against 882 before.

The boundary: exactly at the cap accepted, one over refused, an input under the
cap that exceeds it after normalising refused, a relative href resolved against a
long base refused, whitespace trimmed before measuring.

The property that matters is asserted as a property, not a claim: the
10,000-character path returns `null`, so `isAllowed` is never called with it —
`decide.ts` returns at the identity step before reaching the robots step. And the
matcher is timed at the ceiling against the same 255-rule corpus the measurement
came from.

⚠️ **The verdict of that timing test is deliberately not asserted.** The corpus
returns `allowed: false`, and not because of the hostile rules: the 512,000-byte
parse cap cuts the last rule mid-pattern, leaving a 420-character
`Disallow: /aaa…` with its `*` and final `b` gone, and an unanchored pattern is a
prefix match. That is the truncation defect from dev log 0018 — the next brief.
Asserting a boolean governed by a known separate defect would make this test fail
when that defect is fixed, for a reason unrelated to what it covers.

## Related

- [ADR-0033](ADR-0033-url-normalisation.md) — the one definition of crawl identity
- [ADR-0036](ADR-0036-frontier-budget-and-ceiling.md) — `page_limit` and the frontier ceiling
- [ADR-0032](ADR-0032-crawler-network-security.md) — `admitUrl` and the admission ceiling
- [dev log 0018](../development-log/0018-the-regex-sweep.md) — the measurement this fixes
