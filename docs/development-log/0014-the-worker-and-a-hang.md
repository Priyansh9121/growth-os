# 0014 — The worker, and a process that would not exit

**Date:** 2026-08-16 · **Stage:** 3

## Objective

Give the platform somewhere to run background work, and use it for the retention
jobs Stage 2.5 specified and could not schedule.

## Initial state

Four retention rules written down in
[data-lifecycle.md](../security/data-lifecycle.md) and nothing to run them.
Sessions, reset tokens and rate-limit windows accumulated indefinitely.

## Decisions

### PostgreSQL, not Redis — [ADR-0030](../decisions/ADR-0030-worker-and-queue.md)

The deciding property is not throughput:

> **A job enqueued inside a transaction commits with the data that caused it.**

A job written by a transaction that later rolls back simply does not exist.
Enqueuing to Redis from inside a database transaction is a distributed-commit
problem, and the standard answer to it is an outbox table in PostgreSQL — so the
queue would be in PostgreSQL anyway, with Redis added.

Redis was rejected a second time for rate limiting, which would put a new hard
dependency **in the lead-capture path**: fail closed and a customer's form stops
accepting enquiries because a cache is down; fail open and the limiter silently
stops working. Neither is acceptable for the endpoint that earns the money.

`SELECT … FOR UPDATE SKIP LOCKED` is the ordinary way to build this. If a future
stage measures PostgreSQL failing under the crawler's job rate, **that
measurement** is what justifies Redis — not a prediction.

### A second process, not a second service

Same repository, packages, database and deployment artefact. **No network API
between the worker and the web app**, and there must not be one — that is the
line between a second process and a second service
([ADR-0001](../decisions/ADR-0001-architecture-style.md)).

Four boundary probes enforce it: the worker cannot import Next.js, React,
`@growth-os/ui`, or `apps/web`.

### Three jobs scheduled, three deliberately not

Scheduled hourly: expired sessions, expired reset tokens, stale rate-limit
windows. All three delete already-expired rows, which is what makes them safe to
run twice — and they will be, because the queue is at-least-once.

**Not scheduled:** soft-deleted contacts, `ingestion_receipts`, `audit_events`.
There is no decided retention rule for any of them. Inventing one so a table
looks handled is how customer data gets deleted on a schedule nobody agreed to.

## Failures encountered

This is the substance of the entry. `npm run worker -- --once` hung, and it took
three separate bugs to explain why — each one hiding the next.

### 1. Nothing in the process could close the database

```ts
export function createDatabase(options) {
  const client = postgres(connectionString, …);   // captured in a closure
  return drizzle(client, …);                      // the client is never returned
}
```

The pool existed and nothing held a reference to it. `setDatabase(null)` dropped
the handle and **leaked the connections** — a pooled connection with a 30-second
idle timeout keeps the Node event loop alive, so the process did all its work
correctly and then sat there.

The fix is a `WeakMap` from database handle to client, so `closeDatabase()` can
find the pool. Weak, so an unheld handle stays collectable rather than becoming
immortal.

`closeDatabase()` deletes the registry entry **before** the `await`, which makes
a concurrent second call a no-op rather than a race. It is safe when nothing was
ever initialised, and it does not throw because it is already closed — a
shutdown path that fails while shutting down turns a clean exit into a crash.

> **⚠️ There is no `process.exit()` anywhere near this.** Forcing exit would have
> hidden the ownership bug rather than fixed it, and would sever an in-flight
> transaction instead of letting it settle. The worker's `finally` covers the
> happy path, a signal and a fatal error alike; a fatal error sets
> `process.exitCode` and lets Node drain.

**Who owns the pool** is now written down, in
[worker-architecture.md §6](../architecture/worker-architecture.md#6-️-database-ownership)
and on `getDatabase` itself: the process entry point owns it, `apps/web` never
closes it, `apps/worker` does, and tests each close what they opened.

### 2. npm ate the flag

```
"worker": "npm run start --workspace @growth-os/worker"
```

`npm run worker -- --once` expands to
`npm run start --workspace @growth-os/worker --once`, and **npm consumed
`--once` as an unknown CLI config**. Every "once" run was silently a loop.

That was the actual cause of the original two-minute hang, and it was invisible
because the failure mode of the real bug — a process that never exits — is
identical to the failure mode of accidentally running the loop.

Fixed by ending the root script with `--`.

### 3. A pass could not claim the jobs it had just scheduled

With the first two fixed, `--once` exited in about a second and reported
`ran: 0`.

`scheduleRecurring` called `enqueue`, which defaulted `run_at` to a fresh
`new Date()` — a few milliseconds **after** the `now` the pass would filter
with. So `run_at <= now` excluded everything the pass had just created.

Loop mode self-corrected on the next tick and hid it completely. Only `--once`
could show it, and only after it had been fixed enough to run at all.

The fix is to pass the pass's own clock. The regression test is the first one in
the suite.

### 4. A retention job that failed silently, five times

`prune-rate-limit-windows` bound a `Date` into a raw `sql` template. It threw at
runtime, retried with backoff, exhausted its attempts and went terminally
`failed` — announced by nothing but a row in a table.

Fourth occurrence of this class in the codebase, and the first one a scheduled
job hit rather than a test. Fixed with Drizzle's `lt()`.

**The lesson is not about dates.** It is that a queue whose failures are silent
is worse than no queue, because the work looks done. The worker logs terminal
failures, and the test suite asserts the retry-then-fail path.

### 5. The boundary probes compiled happily

The worker's ESLint block was placed **before** the generic `apps/**` block.
ESLint flat config **replaces** rule options rather than merging them, so the
generic block overwrote the worker's restrictions and all four illegal imports
were legal.

Found by writing probes that should fail and watching them pass. Fixed by moving
the block after the generic one, with the hazard documented in a comment —
because the next person to add a rule will put it wherever looks tidy.

## Files created

```
apps/worker/src/{main,queue,jobs}.ts
apps/worker/src/worker.integration.test.ts
packages/database/src/client.ts          (modified: the ownership fix)
docs/architecture/worker-architecture.md
docs/decisions/ADR-0030-worker-and-queue.md
```

## Testing

18 integration cases: scheduling and the immediate-claim regression, dedupe per
window, batch limits, concurrent claiming through `SKIP LOCKED`, retry, backoff,
terminal failure, error truncation, stalled reclaim, and **four database
lifecycle properties** — closing is idempotent, safe when nothing was
initialised, safe under concurrent calls, and a closed handle refuses further
queries rather than silently reconnecting.

That last one matters: a handle that transparently reopened would make "did I
close it?" unanswerable and would resurrect the event-loop leak the whole
mechanism exists to fix.

One assertion is deliberately a **set** rather than a list. `UPDATE … RETURNING`
emits rows in the order it updated them, which need not match the subquery's
`ORDER BY`. The guarantee is _which_ jobs are claimed — fairness comes from the
selection — not the order they come back in.

## Result

```bash
npm run worker -- --once
[worker] pass complete { ran: 3 }
```

Exits naturally in about a second, having scheduled and run three jobs, with no
`process.exit()` anywhere.

## Remaining work

- The three unscheduled retention rules stay unscheduled until someone decides
  them. Named in the architecture doc rather than quietly omitted.
- Stage 4's crawler adds job definitions; it does not redesign ownership.
