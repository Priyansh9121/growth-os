# @growth-os/worker

Background jobs. **A second process, not a second service.**

## Responsibility

Work that should not happen inside a request: scheduled retention, and — from
Stage 4 — crawling.

## Why it exists at all

Stage 2.5 finished with retention functions that were implemented, correct, and
unrunnable, because nothing existed to run them. This is that something, kept
deliberately small.

## Why PostgreSQL and not Redis

Decided in [ADR-0030](../../docs/decisions/ADR-0030-worker-and-queue.md). The
property that settled it is not throughput: **a job enqueued inside a
transaction commits with the data that caused it.** A job written by a
transaction that later rolls back simply does not exist. Enqueuing to Redis from
inside a database transaction is a distributed-commit problem, and the standard
solution to it is an outbox table in PostgreSQL.

Redis is also rejected *for now* because distributed rate limiting would put a
new hard dependency in the lead-capture path — fail closed and a customer's form
stops accepting enquiries because our cache is down; fail open and the limiter
silently stops working.

## It is part of the monolith

Same repository, same packages, same database, same deployment artefact. There
is **no network API** between it and the web app, and there must not be one:
that is the line between a second process and a second service
([ADR-0001](../../docs/decisions/ADR-0001-architecture-style.md)).

## Jobs

| Job | Rule | Schedule |
| --- | ---- | -------- |
| `prune-expired-sessions` | Past idle or absolute expiry | Hourly |
| `prune-expired-reset-tokens` | Expired, plus used older than one TTL | Hourly |
| `prune-rate-limit-windows` | Counter windows that can no longer be current | Hourly |

### ⚠️ What is deliberately NOT scheduled

Soft-deleted contacts, `ingestion_receipts` and `audit_events` have **no decided
deletion rule** — only a "target" in one case. They stay unscheduled on purpose.
Inventing a rule so a table looks handled is how customer data gets deleted on a
schedule nobody agreed to.

## May depend on

`@growth-os/contracts`, `@growth-os/database`, `@growth-os/auth`,
`@growth-os/forms`, `drizzle-orm`.

## Must NOT

- Import `@growth-os/ui`, React, Next.js, or `apps/web`.
- Expose an HTTP API.
- Carry PII in a job payload — payloads hold identifiers and parameters, and a
  handler loads what it needs through a tenant-scoped service.

## Security boundary

The worker connects as an **operational** role and does platform-wide work, so
it is outside the tenant transaction model for the jobs it currently runs. Any
future job touching customer data must open a `withTenantTransaction` for the
workspace it is acting on — the same rule as everything else.

## Running

```bash
npm run worker            # long-running
npm run worker -- --once  # one pass, for CI and tests
```
