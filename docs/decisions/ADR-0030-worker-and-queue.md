# ADR-0030 — A PostgreSQL-backed worker, and no Redis yet

**Status:** Accepted
**Date:** 2026-08-16

## Context

Stage 2.5 finished with retention work that could not run: there was no job
runner. Stage 3 is the first point where activating one is proportionate, and
the obvious question is whether to bring in Redis + BullMQ now — Stage 4's
crawler will generate far more jobs, and Redis would also give distributed rate
limiting for the new public endpoint.

Three candidate consumers were assessed against what they actually need **today**:

| Consumer                            | Volume               | Needs                               |
| ----------------------------------- | -------------------- | ----------------------------------- |
| Retention purges (Stage 3)          | 2 jobs, hourly/daily | A schedule. Not a queue             |
| Public form rate limiting (Stage 3) | Per request          | Shared counters across instances    |
| Crawler (Stage 4)                   | Thousands per site   | Real queueing, concurrency, retries |

Only the third genuinely wants a queue, and it is not this stage.

## Decision

**A PostgreSQL-backed job table with `FOR UPDATE SKIP LOCKED`, run by a small
`apps/worker`. No Redis.**

### 1. Why PostgreSQL is not a compromise here

`SELECT … FOR UPDATE SKIP LOCKED` is the standard, boring way to build a work
queue on PostgreSQL. It gives at-least-once delivery, safe concurrent claiming
across any number of workers, and — the part Redis cannot match — **jobs commit
in the same transaction as the data that created them.**

That last property matters more than throughput at this stage. A job enqueued
in a transaction that later rolls back simply does not exist, whereas a Redis
enqueue inside a database transaction is a distributed-commit problem that gets
solved with an outbox table… in PostgreSQL.

Throughput is not close to being the constraint: a single PostgreSQL instance
handles thousands of jobs per minute through this pattern, against a Stage 3
requirement of roughly two per hour.

### 2. Why Redis is NOT added now

**It would put a new hard dependency in the lead-capture path.** Distributed
rate limiting means Redis is consulted on every public submission. If Redis is
unavailable, the honest options are to fail closed (a customer's website form
stops accepting enquiries because _our_ cache is down) or fail open (the rate
limiter silently stops working). Neither is acceptable for the endpoint whose
entire job is not losing leads.

**The problem it solves does not exist yet.** Distributed rate limiting matters
when more than one instance runs. Growth OS runs one.
[ADR-0009](ADR-0009-rate-limiting.md) already records this as a **release
gate**, behind a driver interface, so adopting Redis later is a constructor
change and not a rewrite.

**Adding it "because Stage 4 will need it" is speculative infrastructure.** If
the crawler proves PostgreSQL insufficient, that is the moment to introduce
Redis — with a measurement rather than a prediction, and without the lead path
already depending on it.

### 3. Rate limiting is two tiers, and each is honest about its scope

| Tier      | Where      | Catches                               | Limit                            |
| --------- | ---------- | ------------------------------------- | -------------------------------- |
| Burst     | In-process | A flood from one host at one instance | 5 / 10s per IP                   |
| Sustained | PostgreSQL | Volume across instances and over time | 20/h per IP+form, 200/h per form |

The burst tier runs first and costs no I/O, so a flood is rejected before it can
amplify into database writes — the tier-2 counter is only touched by requests
that already passed tier 1.

The durable tier is a small upsert per surviving request. At lead-capture
volumes that is negligible; if it ever is not, the driver interface is where
Redis goes.

**Stated limitation:** with one instance, tier 1 is genuinely effective. With
several, tier 1 becomes per-instance and tier 2 carries the guarantee. That is
why tier 2 exists now rather than later.

### 4. The worker is part of the monolith

`apps/worker` is a **second process, not a second service.** Same repository,
same packages, same database, same deployment artefact, no network API between
it and the web app. It exists because a long-running loop should not live inside
a request handler ([ADR-0001](ADR-0001-architecture-style.md)).

### 5. Only jobs with a decided retention rule are scheduled

Stage 2.5 listed four unscheduled retention items. Two have an implemented
function with a defined rule, and those are scheduled:

| Job                          | Rule                                  | Schedule |
| ---------------------------- | ------------------------------------- | -------- |
| `prune-expired-reset-tokens` | Expired, plus used older than one TTL | Hourly   |
| `prune-expired-sessions`     | Past idle or absolute expiry          | Hourly   |

The other three — soft-deleted contacts, `ingestion_receipts`, `audit_events` —
have **no decided deletion rule**, only a "target" in one case. They are left
unscheduled on purpose. Inventing a rule so a table looks handled is how
customer data gets deleted on a schedule nobody agreed to.

### 6. Failure handling

At-least-once with a visible dead-letter state: `attempts`, `max_attempts`,
`last_error`, exponential backoff, and a terminal `failed` status. **Jobs must
be idempotent**, and both scheduled jobs are (deleting already-expired rows
twice deletes nothing the second time).

## Alternatives considered

**Redis + BullMQ now.** Mature, good tooling, and the right answer eventually.
Rejected today: a new failure mode in the lead path, an operational dependency,
and no consumer that PostgreSQL cannot serve.

**`pg_cron`.** Removes the worker entirely for scheduled jobs. Rejected: it is
an extension many managed providers do not offer, jobs would be written in SQL
rather than the typed services that already exist, and Stage 4 needs a real
queue regardless.

**Cloud-provider scheduler hitting an HTTP endpoint.** Ties the schedule to a
hosting choice not yet made, and puts long-running work back in a request.

**No worker; run retention on boot.** A restart-driven schedule is not a
schedule.

## Consequences

### Positive

- Jobs enqueue transactionally with the data that caused them.
- No new infrastructure, no new failure mode in lead capture.
- Retention finally runs.
- Stage 4 has a queue to build on, and evidence to justify Redis if it needs it.

### Negative

- Polling costs a query per interval per worker. Trivial at this scale;
  `LISTEN/NOTIFY` is the documented next step before Redis.
- Throughput ceiling is lower than Redis. Far above Stage 3's needs, and
  measured before Stage 4 commits.
- Distributed rate limiting is still not solved for multi-instance. Unchanged
  from Stage 2.5, still a documented release gate.

## Revisit when

- More than one application instance runs → the ADR-0009 gate fires.
- Stage 4 measures the crawler's job rate against this queue.
- Polling latency becomes visible to a user.

## Related

- [ADR-0001](ADR-0001-architecture-style.md) · [ADR-0009](ADR-0009-rate-limiting.md)
- [architecture/worker-architecture.md](../architecture/worker-architecture.md)
