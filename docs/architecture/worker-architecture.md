# Worker Architecture

**Status:** Implemented (Stage 3)
**Last verified:** 2026-08-16

`apps/worker` — background jobs. **A second process, not a second service.**

---

## 1. What it is, and what it is not

| It is                                                    | It is not                                  |
| -------------------------------------------------------- | ------------------------------------------ |
| A second **process** in the modular monolith             | A microservice                             |
| Same repository, packages, database, deployment artefact | A separate deployable with its own release |
| A polling loop over a PostgreSQL table                   | An HTTP server                             |

There is **no network API** between the worker and the web app, and there must
not be one — that is the line between a second process and a second service
([ADR-0001](../decisions/ADR-0001-architecture-style.md)).

Four boundary probes enforce it: the worker cannot import Next.js, React,
`@growth-os/ui`, or `apps/web`. They earned their place immediately — the
worker's lint rules were originally placed _before_ the generic `apps/**` block,
and ESLint flat config **replaces** rule options rather than merging them, so
all four illegal imports compiled happily until the probes said otherwise.

## 2. Why PostgreSQL and not Redis

[ADR-0030](../decisions/ADR-0030-worker-and-queue.md). The deciding property is
not throughput:

> **A job enqueued inside a transaction commits with the data that caused it.**

A job written by a transaction that later rolls back simply does not exist.
Enqueuing to Redis from inside a database transaction is a distributed-commit
problem, and the standard solution to it is an outbox table in PostgreSQL.

Redis was also rejected because distributed rate limiting would put a new hard
dependency in the **lead-capture path**: fail closed and a customer's form stops
accepting enquiries because our cache is down; fail open and the limiter
silently stops working.

`SELECT … FOR UPDATE SKIP LOCKED` is the ordinary way to build a queue here. Each
worker takes rows nothing else holds and skips the rest, so two workers never
claim the same job and neither blocks — at a throughput far above this stage's
three jobs per hour.

## 3. Job lifecycle

```
  pending ──claim──▶ running ──success──▶ completed
     ▲                  │
     │                  ├──failure, attempts < max──▶ pending  (backoff)
     │                  │
     │                  └──failure, attempts = max──▶ failed   (terminal)
     │
     └──── reclaim, claimed > 10 min ago ────────────┘
```

**At-least-once, so every handler is idempotent.** A worker killed mid-job
leaves the row `running`; the reaper returns it to `pending` and it runs again.
All three retention jobs delete already-expired rows, which the second run finds
none of.

Backoff is exponential and capped at an hour. Past `max_attempts` a job becomes
terminally `failed` rather than retrying forever — a job that cannot succeed
should stop consuming capacity and start being visible.

## 4. Scheduling

Recurring jobs are enqueued with a dedupe key of `<name>:<window>`, where the
window is the current interval bucket. However many workers call
`scheduleRecurring`, and however often, exactly one job exists per window — and
the **unique index** enforces it, not application code, because two schedulers
racing is exactly when an application check loses.

Intervals rather than cron expressions: nothing here needs "the first Tuesday of
the month", and a cron parser is a dependency plus a timezone conversation for
no gain.

### ⚠️ The clock a pass schedules with

`scheduleRecurring` stamps `run_at` with **the pass's own `now`**, not a fresh
`new Date()`.

That is not a detail. `enqueue` originally defaulted `run_at` to the moment it
ran — milliseconds after the `now` the pass would filter with — so `run_at <=
now` excluded every job the pass had just scheduled and it claimed nothing. Loop
mode self-corrected on the next tick and hid it completely; `--once` reported a
clean pass having done no work at all.

## 5. Scheduled jobs

| Job                          | Rule                                          | Interval |
| ---------------------------- | --------------------------------------------- | -------- |
| `prune-expired-sessions`     | Past idle or absolute expiry                  | Hourly   |
| `prune-expired-reset-tokens` | Expired, plus used older than one further TTL | Hourly   |
| `prune-rate-limit-windows`   | Counter windows that can no longer be current | Hourly   |

### ⚠️ What is deliberately NOT scheduled

Stage 2.5 listed four unscheduled retention items. Three are still absent:

| Data                  | Why not                                             |
| --------------------- | --------------------------------------------------- |
| Soft-deleted contacts | **No decided deletion rule.** ADR-0013's open gap   |
| `ingestion_receipts`  | No decided rule. No PII, so the pressure is storage |
| `audit_events`        | A 400-day _target_, never a decision                |

Inventing a rule so a table looks handled is how customer data gets deleted on a
schedule nobody agreed to. These stay unscheduled until someone decides.

## 6. ⚠️ Database ownership

The single most important thing in this document, because getting it wrong
produced a process that did all its work correctly and then **hung forever**.

> **The process entry point owns the pool. Nothing else may close it.**

| Owner         | Closes it?                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/web`    | **Never.** A long-running server; a request handler that closed the pool would break every subsequent request |
| `apps/worker` | **Yes** — `--once` is a finite program that must end, and the loop closes after its final pass                |
| Tests         | Each closes what it opened                                                                                    |

`createDatabase` used to capture the `postgres` client in a closure and never
return it, so nothing in the process could reach the pool. `setDatabase(null)`
dropped the reference and leaked the connections. A `WeakMap` registry now lets
`closeDatabase()` find the client — weak, so an unheld handle is still
collectable rather than immortal.

`closeDatabase()` is idempotent (the registry entry is removed _before_ the
await, so a concurrent second call is a no-op), safe when nothing was ever
initialised, and does not throw because it is already closed — a shutdown path
that fails while shutting down turns a clean exit into a crash.

**There is no `process.exit()` anywhere near this.** Forcing exit would hide the
ownership bug rather than fix it, and would sever an in-flight transaction
instead of letting it settle. The worker's `finally` covers the happy path, a
signal, and a fatal error alike; a fatal error sets `process.exitCode` and lets
Node drain.

## 7. Shutdown

`SIGTERM` and `SIGINT` set a flag rather than exiting. The current pass
finishes, the pool closes, and the process ends naturally.

A job interrupted between finishing its work and writing its `completed` row
would be reclaimed and run again — safe, because handlers are idempotent, but
pointless.

## 8. Operations

```bash
npm run worker            # long-running
npm run worker -- --once  # a single pass, for CI and tests
```

The root script ends in `--` so arguments forward. Without it, `npm` consumed
`--once` as an unknown CLI config and every "once" run was silently a loop.

`--once` matters more than it looks: it is how the test suite exercises real
scheduling without waiting real hours, and how CI proves the worker boots and
drains a queue rather than only that it compiles.

## 9. Security

The worker connects as an **operational** role and does platform-wide work, so
the jobs it runs today are outside the tenant transaction model.

**Any future job touching customer data must open a `withTenantTransaction` for
the workspace it acts on** — the same rule as everything else. A job payload
carries identifiers and parameters, never PII, because a queue row is a fan-out
surface like an event.

`jobs` is not workspace-scoped and therefore not RLS-protected. That is recorded
in the migration and in [data-lifecycle.md](../security/data-lifecycle.md),
because a table without a policy should always have an answer attached.

## 10. Stage 4 readiness

The crawler adds job definitions; it does not redesign process ownership. Claim
semantics, retries, terminal failure, stalled reclaim, scheduling and shutdown
are all in place and tested.

The one thing Stage 4 must bring is **evidence**: if PostgreSQL cannot carry the
crawler's job rate, that measurement is what justifies Redis — not a prediction.

## Related

- [ADR-0030](../decisions/ADR-0030-worker-and-queue.md) · [ADR-0001](../decisions/ADR-0001-architecture-style.md) · [ADR-0009](../decisions/ADR-0009-rate-limiting.md)
- [apps/worker/README.md](../../apps/worker/README.md)
