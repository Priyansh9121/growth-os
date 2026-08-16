/**
 * The background job queue.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One table, claimed with `FOR UPDATE SKIP LOCKED`, run by `apps/worker`.
 * Stage 2.5 finished with retention work that could not run because no job
 * runner existed; this is that runner's storage.
 *
 * WHY POSTGRESQL RATHER THAN REDIS (ADR-0030)
 * The property that decided it is not throughput — it is that **a job enqueued
 * inside a transaction commits with the data that caused it.** A job written by
 * a transaction that later rolls back simply does not exist. Enqueuing to Redis
 * from inside a database transaction is a distributed-commit problem, and the
 * standard solution to it is an outbox table in PostgreSQL.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` is the ordinary way to build a queue here.
 * It gives at-least-once delivery and safe concurrent claiming across any
 * number of workers, at a throughput far above this stage's two jobs per hour.
 *
 * NOT WORKSPACE-SCOPED, AND THEREFORE NOT RLS-PROTECTED
 * Deliberate, and recorded because a table without RLS should always have an
 * answer attached. Jobs are PLATFORM work — pruning expired sessions across
 * every tenant, sweeping rate-limit windows. A job carries a `workspace_id`
 * only when its payload happens to name one, and the worker connects as an
 * operational role rather than through a tenant transaction.
 *
 * A job payload MUST NOT carry PII. It carries identifiers and parameters; the
 * handler loads what it needs through a tenant-scoped service.
 *
 * @see docs/decisions/ADR-0030-worker-and-queue.md
 * @see docs/architecture/worker-architecture.md
 */

import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { JOB_STATUSES } from '@growth-os/contracts';

export const jobStatusEnum = pgEnum('job_status', JOB_STATUSES);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Registered handler name, e.g. `prune-expired-sessions`. */
    name: text('name').notNull(),

    /**
     * Handler parameters. Identifiers and settings only — never a name, an
     * email or a payload. A queue row is a fan-out surface like an event.
     */
    payload: jsonb('payload').$type<Record<string, string | number | boolean>>(),

    status: jobStatusEnum('status').notNull().default('pending'),

    /** Not claimable before this. Backoff and scheduling both use it. */
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),

    /**
     * The last failure's message. Truncated by the worker before it is
     * written, because a driver error can quote the row that caused it.
     */
    lastError: text('last_error'),

    /**
     * Optional dedupe key.
     *
     * A recurring job uses `<name>:<window>`, so a scheduler that fires twice —
     * two workers, a restart, a clock adjustment — enqueues once. The unique
     * index below is what enforces it; the check is not in application code,
     * because two schedulers racing is exactly when application checks lose.
     */
    dedupeKey: text('dedupe_key'),

    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // THE CLAIM QUERY: pending jobs whose time has come, oldest first.
    index('jobs_claimable_idx').on(table.status, table.runAt),
    uniqueIndex('jobs_dedupe_key_unique').on(table.dedupeKey),
    index('jobs_name_created_idx').on(table.name, table.createdAt),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
