/**
 * The job queue.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Claiming, running, retrying and failing jobs, on PostgreSQL, with
 * `FOR UPDATE SKIP LOCKED`.
 *
 * WHY `SKIP LOCKED` IS THE WHOLE DESIGN
 * It is what makes concurrent claiming safe without a lock table, a lease
 * column, or a coordinator. Each worker takes rows nothing else holds and
 * skips the rest, so two workers never claim the same job and neither blocks
 * on the other. It has been the standard PostgreSQL queue pattern since 9.5.
 *
 * AT-LEAST-ONCE, SO JOBS MUST BE IDEMPOTENT
 * A worker that dies mid-job leaves it claimed; the reaper returns it to
 * `pending` and it runs again. Every registered handler is therefore written
 * so that running it twice is the same as running it once — the three
 * retention jobs delete already-expired rows, which the second run finds none
 * of.
 *
 * @see docs/decisions/ADR-0030-worker-and-queue.md
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import { schemaTables, type Database } from '@growth-os/database';

const { jobs } = schemaTables;

export interface JobContext {
  readonly db: Database;
  readonly payload: Record<string, string | number | boolean>;
  readonly now: Date;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface JobDefinition {
  readonly name: string;
  readonly handler: JobHandler;
  /**
   * How often to enqueue it, in seconds. Omitted for jobs enqueued on demand.
   *
   * The schedule is expressed as an INTERVAL rather than a cron expression on
   * purpose: nothing here needs "the first Tuesday of the month", and a cron
   * parser is a dependency plus a timezone conversation for no gain.
   */
  readonly everySeconds?: number;
}

/**
 * Claim up to `limit` jobs.
 *
 * The claim and the status change are ONE statement. A select-then-update would
 * leave a window where two workers both saw the row as pending — which is
 * precisely the race a queue exists to prevent.
 */
export async function claimJobs(
  db: Database,
  limit: number,
  now: Date,
): Promise<
  {
    id: string;
    name: string;
    payload: Record<string, string | number | boolean> | null;
    attempts: number;
    maxAttempts: number;
  }[]
> {
  const rows = await db.execute<{
    id: string;
    name: string;
    payload: Record<string, string | number | boolean> | null;
    attempts: number;
    max_attempts: number;
  }>(sql`
    update jobs
       set status = 'running',
           claimed_at = ${now.toISOString()}::timestamptz,
           attempts = attempts + 1
     where id in (
       select id from jobs
        where status = 'pending'
          and run_at <= ${now.toISOString()}::timestamptz
        order by run_at
        limit ${limit}
          for update skip locked
     )
    returning id, name, payload, attempts, max_attempts
  `);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

export async function completeJob(db: Database, id: string, now: Date): Promise<void> {
  await db.update(jobs).set({ status: 'completed', completedAt: now }).where(eq(jobs.id, id));
}

/**
 * Record a failure, and decide whether to retry.
 *
 * Exponential backoff, capped at an hour. Past `max_attempts` the job becomes
 * terminally `failed` rather than retrying forever — a job that cannot succeed
 * should stop consuming capacity and start being visible.
 */
export async function failJob(
  db: Database,
  job: { id: string; attempts: number; maxAttempts: number },
  error: unknown,
  now: Date,
): Promise<void> {
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffSeconds = Math.min(3600, 2 ** job.attempts * 10);

  await db
    .update(jobs)
    .set({
      status: exhausted ? 'failed' : 'pending',
      runAt: new Date(now.getTime() + backoffSeconds * 1000),
      // TRUNCATED before storage: a driver error can quote the row that caused
      // it, and a job payload is not somewhere PII should reach a log column.
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      ...(exhausted ? { completedAt: now } : {}),
    })
    .where(eq(jobs.id, job.id));
}

/**
 * Enqueue a job.
 *
 * `dedupeKey` makes it idempotent: a scheduler firing twice — two workers, a
 * restart, a clock adjustment — enqueues once, because the unique index
 * refuses the second. The check is the DATABASE's, not the application's, since
 * two schedulers racing is exactly when an application check loses.
 */
export async function enqueue(
  db: Database,
  input: {
    name: string;
    payload?: Record<string, string | number | boolean>;
    runAt?: Date;
    dedupeKey?: string;
  },
): Promise<boolean> {
  const inserted = await db
    .insert(jobs)
    .values({
      name: input.name,
      payload: input.payload ?? null,
      runAt: input.runAt ?? new Date(),
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });

  return inserted.length > 0;
}

/**
 * Return jobs abandoned by a dead worker.
 *
 * A worker killed mid-job leaves a row `running` forever. This is what makes
 * the queue at-least-once rather than at-most-once — and it is why handlers
 * must be idempotent.
 */
export async function reclaimStalledJobs(db: Database, stalledBefore: Date): Promise<number> {
  const reclaimed = await db
    .update(jobs)
    .set({ status: 'pending', claimedAt: null })
    .where(and(eq(jobs.status, 'running'), lt(jobs.claimedAt, stalledBefore)))
    .returning({ id: jobs.id });

  return reclaimed.length;
}

/**
 * Enqueue every recurring job whose window has come.
 *
 * The dedupe key is `<name>:<window>`, where the window is the current interval
 * bucket — so however many workers call this, and however often, exactly one
 * job exists per window.
 */
export async function scheduleRecurring(
  db: Database,
  definitions: readonly JobDefinition[],
  now: Date,
): Promise<number> {
  let scheduled = 0;

  for (const definition of definitions) {
    if (!definition.everySeconds) continue;

    const window = Math.floor(now.getTime() / (definition.everySeconds * 1000));
    const created = await enqueue(db, {
      name: definition.name,
      // ⚠️ THE PASS'S OWN CLOCK, not a fresh `new Date()`.
      //
      // `enqueue` defaults `runAt` to the moment it runs, which is a few
      // milliseconds AFTER the `now` this pass will filter with — so
      // `run_at <= now` excluded every job the pass had just scheduled, and it
      // claimed nothing. In loop mode that self-corrects on the next tick and
      // is invisible; `--once` reported a clean pass having run no work at
      // all, which is precisely what `--once` exists to catch.
      runAt: now,
      dedupeKey: `${definition.name}:${window}`,
    });
    if (created) scheduled += 1;
  }

  return scheduled;
}
