# 0036 — The crawler gets a caller, and a CHECK constraint corrected the design

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Wire `@growth-os/crawler` into the product for the first time: a worker job that
runs a crawl, and the API surface for a person to start one and read the result.
No new crawler capability — this composes what exists.

[0035](0035-the-status-document.md)'s audit is the reason: every subsystem was
built and tested in isolation, and **nothing invoked any of it.**

## Initial state

Verified, not recalled: `238b1bd`, tree clean, `verify:all` exit 0 at **1240
passed / 245 skipped (1485)**, 29 boundary probes, remote PRIVATE, `0 0`
ahead/behind. Matched the brief.

## Re-measured before designing

The brief asked for two facts to be established by reading rather than assumed.
Both held, and two more turned up that the brief had not anticipated.

- **No production code creates a crawl row.** All six `insert(crawls)` call
  sites in the repository are test fixtures inside `packages/crawler`.
- **Verification enforcement.** `sites.verification_state` exists with a
  `verified` value, `verifySite` sets it, and **nothing reads it as a gate.**
- ⚠️ **`enqueue` existed only in `apps/worker/src/queue.ts`**, and nothing
  outside the worker has ever enqueued a job. `apps/web` cannot import
  `apps/worker`. The web app had no path to the jobs table at all.
- ⚠️ **The budget already exists.** `sites.crawl_page_limit` (500) and
  `crawl_max_depth` (10) are columns with defaults. The brief asked me to decide
  between "from the site or sane defaults"; the schema had already decided, so
  nothing was invented.

## The two gates

`requestCrawl` checks the capability, then verification, then writes.

| Gate         | Asks                          | Granted by                    | Refusal              |
| ------------ | ----------------------------- | ----------------------------- | -------------------- |
| Capability   | May this PERSON start crawls? | `workspace:crawls:run`        | `AuthorizationError` |
| Verification | Is this DOMAIN ours?          | Publishing a proof (ADR-0031) | `ConflictError`      |

The capability runs first so an unauthorised caller cannot use the error code as
an existence oracle. Refusal for verification is 409 rather than 403 because the
caller may well hold `crawls:run` — the **site** is in the wrong state, and the
fix is to verify it.

⚠️ **"`runCrawl` already does the SSRF checks" is not sufficient**, and the brief
was right to insist. `safeFetch` decides whether an **address** may be
contacted. It cannot decide whether this workspace has any business pointing us
at that address, because that is not a property of the address.
`https://competitor.example` is an ordinary public host: every SSRF control
passes it, and every one of them should.

The tests count `crawls` and `jobs` after **every** refusal. An error that still
wrote a row would pass a `rejects.toThrow()` check and be a live scanning path.

## ⚠️ Finding 1 — the database caught a design error review had passed

The handler was written to mark a crashed crawl `failed` with a **null**
`failure_category`, reasoning that every member of `CRAWL_FAILURE_CATEGORIES`
describes what a _fetch_ did — timeouts, TLS, redirects, robots — and none means
"the run itself threw". Borrowing one would be a typed lie an operator would
then act on. That reasoning is in the first version of ADR-0054.

**`crawls_failed_has_category` refused the row.** Migration 0008's own comment
says why: _"a crawl can fail with no explanation, which is exactly the state an
operator cannot act on."_

The result was the precise failure the handler exists to prevent: the crawl was
left `running` forever, because the write that would have marked it failed was
rejected. The test caught it as `expected 'running' to be 'failed'`.

Both halves of the original argument were true — a null category **is** refused,
and borrowing a fetch category **is** a lie — which means the missing thing was
the category itself. **Migration 0010 adds `internal_error`**, the only member
that describes what _we_ did rather than what a fetch did.

This is §5's _"limits live in the database"_ doing exactly what it is for. A
constraint written four migrations ago rejected a decision that had been reasoned
through, written into an ADR, and reviewed.

## ⚠️ Finding 2 — the failure write uses the handle that just failed

`markCrawlFailed` goes through the same database that may be the thing that
died. Unguarded, its own error **replaced** the original — so the queue recorded
`last_error` as the bookkeeping failure and the real cause was lost.

It is now best-effort, and the original error always propagates.

**The residual gap, stated rather than hidden:** when the database is genuinely
gone, the crawl cannot be marked at all and is left `running`.
`reclaimStalledJobs` reaps stalled **jobs**; nothing reaps stalled **crawls**.
Asserted as the current truth in a test rather than papered over.

## ⚠️ Finding 3 — a transport fault is not a crawl failure, and my test was wrong twice

The obvious way to make the job throw is to break the network. **It does not
throw.** `runCrawl` records a failed fetch as `pagesFailed` and completes — which
is correct: a page that could not be fetched is a fact about that page, and an
operator gets "2 of 2 pages failed, crawl completed" rather than a crawl that
vanished into a retry loop. That behaviour is now pinned by its own test instead
of being assumed.

Finding it required fixing a bug in the test's own transport first. The predicate
was `String(args[0])`, but `args[0]` is a `TransportRequest`, not a URL — so it
stringified to `"[object Object]"` and the transport threw on `robots.txt` too.
Robots failing means fail-closed (ADR-0035), so the whole site came back
disallowed and the frontier was empty. **A completely different scenario that
happened to look like the intended one**, and would have passed a weaker
assertion.

The failure path was then rewritten against a fault the loop genuinely cannot
absorb: a connection lost mid-run.

## What was built

| Slice     | Change                                                                 |
| --------- | ---------------------------------------------------------------------- |
| `f1bddcf` | The `workspace:crawls:*` grant test §5 required and nobody had written |
| `6d3dafb` | `enqueue` moves to `@growth-os/database` so one path writes a job row  |
| `48460fa` | `requestCrawl` / `getCrawl` / `claimCrawl` + ADR-0054, 20 tests        |
| `7e9f2a1` | The worker job, migration 0010, the full-loop suite, 10 tests          |
| `26aa204` | Two API routes                                                         |

`enqueue` moved because the alternative was a second insert in `apps/web` that
would have missed the `dedupeKey` conflict clause — the second path §5 exists to
prevent. Claiming, retrying and reaping stayed in the worker; those are the
runner's concerns.

The crawl row and its job commit **in one transaction**, which is the property
ADR-0030 chose PostgreSQL for. Split apart, the failures are a job claiming a
crawl that does not exist, and a crawl queued forever with nothing coming to run
it — neither of which reports anything.

## Testing

- `verify:all` exit 0: **1250 passed / 275 skipped (1525)**, against 1240 / 245
  (1485) at `238b1bd`. 29 boundary probes.
- §7.2: 11 migrations applied from zero on a throwaway database, full suite
  **1525 passed (1525)** exit 0, database destroyed.
- **30 of the 40 new tests need a database and none of them runs in the default
  gate.** The headline number understates this session by design (0035 §1).

The full-loop test drives `requestCrawl` → real `claimJobs` off the real queue →
the handler → reading the outcome back as an operator would. It never reaches
the network: every fetch goes through a `FixtureTransport`.

## Result

A crawl can be started by a person and its outcome read back. This is the first
time any Stage 4 code is reachable from outside a test.

An unverified domain cannot be crawled and **cannot even be queued**.

## Remaining work

1. **Nothing reaps a stalled crawl.** A crawl left `running` by a worker that
   died with the database is invisible forever. `reclaimStalledJobs` is the
   precedent to copy. Its own brief, and the first one I would take.
2. **No UI.** The routes are curl-able and that was the brief's stated bar. A
   site detail page showing crawl history is the obvious next surface.
3. **Cancellation.** `cancel_requested_at` exists and `crawlProgress` reads it;
   nothing sets it. Out of scope here and genuinely small.
4. **HTML link extraction**, still the largest limit on the crawler's
   usefulness: a site with no sitemap yields a one-page crawl, which this
   session's suite now asserts rather than describes.
5. **One page at a time.** `claimNext` already uses `FOR UPDATE SKIP LOCKED`, so
   a worker pool composes without changing `runCrawl`.

⚠️ **Placement to revisit:** `@growth-os/sites` now writes the `crawls` table,
which is another domain's. Recorded in ADR-0054 with the reasoning and the cost.
When scheduled crawls, recrawl policy or crawl retention arrive, that is the seam
to move — and `SitesContext`'s `SystemGrant`, whose docblock already names
`crawl:<id>`, is how a scheduler would authorise itself.

Carried and re-measured: the local dev database is at 8 of 10 migrations — now 8
of **11**, since this session added one, so the gap widened rather than closed.
The client-side email regex, and 0030's question about the 4× expansion ratio,
are unchanged.
