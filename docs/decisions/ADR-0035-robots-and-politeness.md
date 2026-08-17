# ADR-0035 — Fail closed on unreadable robots.txt, and how politeness is applied

**Status:** Accepted
**Date:** 2026-08-17

## Context

Two decisions the crawler cannot avoid making, neither of which has a settled
industry answer:

1. **What may we crawl when we could not read `robots.txt`?**
2. **How hard may we ask a customer's server to work?**

RFC 9309 §2.3.1 covers the first only partly. It is explicit that a `4xx` means
"unavailable, crawl freely", and for `5xx` it says a crawler _should_ treat the
site as disallowed — a SHOULD, which means every implementation picks. Google
disallows for 30 days then degrades to the last-known rules; many crawlers
proceed unrestricted.

The second is not in any RFC at all. `Crawl-delay` is a widely-honoured
extension that RFC 9309 deliberately excludes.

## Decision 1 — fail closed on 5xx, on network failure, and on 401/403

| Outcome                                                           | Effect                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `2xx`                                                             | Rules parsed and applied                              |
| `4xx` (except 401/403)                                            | **Unrestricted.** A definite answer: there is no file |
| `401` / `403`                                                     | **Entire site disallowed**                            |
| `5xx`                                                             | **Entire site disallowed**                            |
| Network failure, timeout, TLS error, SSRF refusal, oversized body | **Entire site disallowed**                            |

### ⚠️ Why 5xx disallows rather than permits

The tempting reading is "there are no rules, so nothing is forbidden". It is
wrong twice.

**First, because of _when_ it happens.** A server returning 500, or refusing
connections, or timing out, is a server under load, misconfigured, or
mid-deploy. That is the exact moment a crawler causes the most harm by
continuing — and the permissive reading is precisely the behaviour that answers
"your server is struggling" with five hundred more requests. The failure mode of
being wrong here is not an abstraction; it is making a customer's outage worse
while wearing their vendor's name.

**Second, because it is not evidence.** _"We could not read robots.txt"_ is not
_"robots.txt permits this"_. Inferring permission from our own failure to ask is
the same error as inferring consent from silence. A site with `Disallow: /`
behind a 503 has told us exactly nothing, and the honest response to learning
nothing is to do nothing.

The cost is real and accepted: a site with a flaky robots.txt endpoint is not
crawled, and the operator sees "we could not read your robots.txt" rather than a
crawl of unknown legitimacy.

`401`/`403` sit with 5xx rather than with 4xx despite being 4xx codes. A server
that _authenticates_ its robots.txt is stating we are not an audience for its
rules; proceeding unrestricted against a file deliberately walled off is the
least defensible reading available.

### ⚠️ Recovery — the part that would otherwise be implemented by accident

`robots.txt` is fetched **once per crawl**, at the start, and cached for that
crawl's lifetime.

Therefore: **a site that failed recovers on the next crawl, not during the
current one. There is no cooldown, no retry loop, and no mid-crawl
revalidation.** Each of those three is a decision:

- **No mid-crawl retry.** A crawl whose permission state changed halfway would
  have fetched some pages under one rule set and some under another, with no
  honest way to report which. A crawl is a measurement, and a measurement whose
  instrument changed mid-way is not one.
- **No cooldown before the next crawl.** Google's 30-day penalty exists because
  Google recrawls continuously; our crawls are minutes or days apart and
  operator-initiated. A cooldown here would add a second timer whose only effect
  is to keep punishing a site that has already recovered — and it would have to
  be explained to a customer who fixed their server and cannot understand why we
  still will not crawl.
- **Cached for the crawl.** Fetching `robots.txt` per page would multiply our
  request count against the one file we consult out of politeness.

`robotsCacheScope()` exists as a named function purely so this has somewhere to
be asserted.

### The rules that could be read are applied

A `robots.txt` larger than the 512 KB parse cap is **truncated, not rejected** —
the rules we read still apply. Truncation is not permission.

That is separate from the 2 MB **transfer ceiling**, which is fail-closed: at
that size the body is an attack on memory rather than a verbose file, and we
have learned nothing about the rules.

## Decision 2 — politeness, and what reads `crawl_concurrency`

The per-site columns (`crawl_concurrency` 1–4, `crawl_delay_ms` 0–60000) are
**CHECK-constrained in the database**, because they decide how hard someone
else's server is asked to work and must not be settable to an arbitrary number
by any application path (AGENTS.md §5).

The policy that reads them:

| Signal                        | Effect                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| Default                       | 2 concurrent requests per origin, 500 ms minimum gap                      |
| `Crawl-delay: n` in our group | Raises the gap to `max(configured, n × 1000)` — **never lowers it**       |
| `429`                         | Back off for this origin; honour `Retry-After` when present and parseable |
| `503`                         | Same as 429. A 503 with `Retry-After` is a server asking politely         |
| `Retry-After` absent          | Exponential backoff from the configured delay, capped                     |

Two properties are load-bearing:

- **`Crawl-delay` can only slow us down.** A site declaring `Crawl-delay: 0` does
  not get 2 ms between requests. Honouring a request to go _faster_ is not
  politeness, and a misconfigured file should not be able to turn the crawler
  into a load generator.
- **Backoff is per origin, not per crawl.** The unit that can be overwhelmed is
  a server, and two crawls of two sites on the same host must not each get a
  full budget.

**Parsing is separate from enforcement.** `parseRobotsTxt` records
`crawlDelaySeconds` and applies nothing. Burying a politeness policy inside a
parser is how it becomes impossible to change without touching a spec
implementation.

⚠️ **The scheduler that applies this is not built yet.** Only the parse side and
the bounded configuration ship in this slice. This ADR records the decision
ahead of the code deliberately, because the alternative is that whoever writes
the scheduler invents a policy and nobody notices it was invented.

## Alternatives considered

**Unrestricted on 5xx.** What several crawlers do. Rejected above: it is
maximally harmful at exactly the wrong moment.

**Google's model — disallow, then fall back to the last-known rules after a
period.** Genuinely better _if_ you have last-known rules, which requires
persisting them per site and reasoning about staleness. Worth revisiting when
crawls are frequent enough for a cached rule set to be recent. Today the first
crawl of a site has nothing to fall back to, so the fallback would be
"unrestricted" — the option already rejected.

**Retry robots.txt a few times before giving up.** Adds requests to a server
that is already failing.

**Ignore `Crawl-delay` entirely,** as RFC 9309 does. It is widely used, it is
one of the few ways a site can express a preference to us, and honouring it
costs a multiplication.

## Consequences

### Positive

- The failure mode is "we did not crawl", never "we crawled something we were
  told not to".
- A struggling server is left alone.
- The deciding rule is reportable, so a skipped page has an explanation from the
  operator's own file.

### Negative

- A site with an intermittently failing robots.txt is not crawled, and the
  operator must fix their server before we are useful to them.
- No last-known-rules fallback, so a transient blip costs a whole crawl.
- The politeness scheduler is specified here and not yet implemented; until it
  is, only the defaults and the database ceilings constrain request rate.

## Verification

`packages/crawler/src/robots` — **69 parse tests, 30 fetch tests**.

Fail-closed asserted on 500/502/503/504/599, 401/403, five transport failure
categories, DNS failure, an SSRF refusal (with a transport that throws if
called), and an oversized body. `4xx` asserted permissive on 404/410/400/418/429.
Truncation asserted to apply the rules it read.

Hostile input: a pathological wildcard pattern completing in bounded time, a
10 MB body, 50,000 rules, 500,000 lines, a 100 KB single pattern, BOM, CRLF,
lone CR, binary noise, and a conflicting file producing a deterministic answer.

## Revisit when

- Crawls become frequent enough that a last-known-rules fallback has something
  recent to fall back to.
- The politeness scheduler is implemented — this ADR is its specification, and
  any divergence from it is a change to be recorded here.

## Related

- [ADR-0032](ADR-0032-crawler-network-security.md) — every fetch, including this one
- [ADR-0033](ADR-0033-url-normalisation.md) — what a path is matched against
- `AGENTS.md` §5, facts vs findings
