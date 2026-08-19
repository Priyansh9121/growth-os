# ADR-0054 — Starting a crawl: the verification gate, and where the service lives

**Status:** Accepted
**Date:** 2026-08-19

## Context

Every crawler subsystem was built and tested in isolation across dev logs
0016–0034. Dev log 0035's audit then measured what nobody had asked: **nothing
invoked any of it.** No `package.json` listed `@growth-os/crawler`, the worker
registered three jobs and none was a crawl, the web app had 23 API routes and
none was a crawl, and `workspace:crawls:run` had no enforcement call site
anywhere. All six `insert(crawls)` call sites in the repository were test
fixtures.

So a crawl could not be started by a person at all. This ADR records the three
decisions that composing one required.

## ⚠️ Re-measured first

- **No production code creates a crawl row.** Confirmed by grep, not assumed.
- **`runCrawl` requires the row to already exist, already be `running`, and
  already be authorised** — its own docblock says so, and says why:
  "authorisation belongs where a crawl is STARTED and re-checking it here would
  put an authorisation decision inside a loop."
- **The budget already lives on the site.** `sites.crawl_page_limit` (500) and
  `sites.crawl_max_depth` (10) exist with defaults and a schema docblock
  explaining that a budget is a property of how hard THIS server may be asked to
  work. Nothing needed to be invented, and nothing was.
- **`enqueue` existed only in `apps/worker`**, so the web app had no path to the
  jobs table. Addressed separately: it moved to `@growth-os/database`.

## Decision 1 — a crawl cannot be QUEUED for an unverified site

The gate is at admission, not at execution.

`requestCrawl` refuses with `ConflictError` unless
`sites.verification_state = 'verified'`, **before any row is written**. A refused
request leaves no crawl row and no job.

### ⚠️ Why "runCrawl does the SSRF checks" is not sufficient

`safeFetch` decides whether an ADDRESS may be contacted. It cannot decide
whether **this workspace has any business pointing us at that address**, because
that is not a property of the address. `https://competitor.example` is a
perfectly ordinary public host: every SSRF control passes it, and every one of
them should.

Without the verification gate, Growth OS is an arbitrary internet-scanning
service anyone can drive by signing up and typing a domain — from our IP
addresses, with our user agent, at our legal risk. That threat is named in
`packages/sites/src/verification.ts`'s own docblock; this is the check that
answers it.

The two controls are orthogonal and both are required. SSRF asks _"is this
address safe to contact?"_. Verification asks _"is this domain yours?"_. Neither
substitutes for the other.

### Why refusal is `ConflictError` (409) and not `AuthorizationError` (403)

403 says _"you may not do this"_, which would be wrong and unactionable: the
caller may well hold `workspace:crawls:run`. The site is in the wrong **state**,
and the fix is to verify it. A 409 with a message naming verification is the
honest answer and the actionable one.

## Decision 2 — the two gates are independent, and both are enforced

| Gate         | Asks                          | Granted by                    | Refusal              |
| ------------ | ----------------------------- | ----------------------------- | -------------------- |
| Capability   | May this PERSON start crawls? | `workspace:crawls:run`        | `AuthorizationError` |
| Verification | Is this DOMAIN ours?          | Publishing a proof (ADR-0031) | `ConflictError`      |

A role can never satisfy the second. That is the point: verification is a proof
about the world, and no amount of privilege inside Growth OS produces it. An
owner of a workspace still cannot crawl a domain they have not verified.

The capability gate runs first, so an unauthorised caller cannot use the error
code to learn whether a site exists or is verified.

## Decision 3 — the service lives in `@growth-os/sites`

The alternatives were `@growth-os/crawler` and the route handler.

**`@growth-os/crawler`** is what its own `package.json` description implies
("the crawl services the worker executes"), and would keep crawl-row writes
inside the crawl domain. Rejected here because the brief that commissioned this
work placed `packages/crawler` explicitly out of scope, and because the decision
being made is overwhelmingly a **sites** decision: the whole operation is
"authorise a crawl of a site whose ownership this workspace has proven", the
gate reads `sites.verification_state`, and the budget columns are on `sites`.
`@growth-os/sites` already declares this responsibility at the top of its own
index: _"VERIFICATION IS THE PERMISSION BOUNDARY FOR CRAWLING."_

**The route handler** was rejected because no API route in this repository is
integration-tested — the convention is a service in a package, tested there,
behind a thin route. Putting the gate in a route would put the one
security-critical decision in this change in the only layer nothing tests.

⚠️ **The cost is stated rather than hidden:** `@growth-os/sites` now writes the
`crawls` table, which is another domain's. If a later stage adds scheduled
crawls, recrawl policy, or crawl retention, this is the seam that should move
into a crawl-services module, and `SitesContext`'s existing `SystemGrant` — whose
docblock already names `crawl:<id>` as an example label — is how a scheduled
crawl would authorise itself without a human.

## Decision 4 — the crawl row and its job commit together

`requestCrawl` writes the `crawls` row and enqueues the job **in one tenant
transaction**. This is the property ADR-0030 chose PostgreSQL over Redis for.

The failure it prevents is not hypothetical in either direction:

- Job enqueued, crawl row rolled back → the worker claims a job pointing at a
  crawl that does not exist.
- Crawl row written, enqueue failed → a crawl sits `queued` forever with nothing
  coming to run it, and no error anywhere.

## Decision 5 — a failed job leaves the crawl `failed`, not `running`

The worker's queue is at-least-once and retries with backoff. A crawl row must
not be left claiming to be in progress by a job that has stopped.

The handler therefore wraps the run and, on any throw, marks the crawl `failed`
with a typed `failure_category` and a short `failure_detail` — then **rethrows**,
so the queue still sees the failure and applies its own retry policy. Swallowing
it would make the job look successful and strand the crawl.

⚠️ `failure_detail` is truncated and carries no URL and no stack trace. The
column's own docblock requires this: the value is shown to a customer, and
`connect ETIMEDOUT 93.184.216.34:443` is neither actionable nor theirs to see.

Because the handler is idempotent on `crawl_id` and the queue is at-least-once,
a retry re-reads the row and re-runs from the frontier's current state rather
than from the beginning.

## Consequences

- A person can start a crawl and read its outcome. This is the first time any
  Stage 4 code is reachable from outside a test.
- An unverified domain cannot be crawled, and cannot even be queued.
- `@growth-os/sites` gains a dependency edge to nothing new — it already
  depended on `@growth-os/database`, which owns both tables.
- The worker gains dependencies on `@growth-os/crawler`, `@growth-os/net` and
  `@growth-os/sites`. No boundary forbids this: apps may depend on any package.

## Alternatives considered

**Run the crawl inline in the request.** Rejected without qualification: a crawl
is minutes of network I/O, and an HTTP handler is not where that belongs.

**Gate on verification at execution time instead of admission.** Rejected: it
would let a caller queue work against a domain they do not own and discover the
refusal only in a worker log, and it puts an authorisation decision inside the
run loop that ADR-0053 deliberately kept out of it.

**Let `crawls:manage` override the verification gate.** Rejected. Verification is
a proof about the world; a capability that waived it would convert an ownership
control into a privilege check, which is exactly the shape that makes a control
decorative.
