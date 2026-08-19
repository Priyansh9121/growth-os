/**
 * Enqueuing background work.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The one way a `jobs` row is written. Claiming, retrying and reaping stay in
 * `apps/worker` — those are the runner's concerns and nothing else should do
 * them — but ENQUEUING is not, because more than one process needs it.
 *
 * ⚠️ WHY THIS MOVED OUT OF THE WORKER.
 * It lived in `apps/worker/src/queue.ts`, which made the worker the only thing
 * able to enqueue: an app may not import another app, so a route that wanted
 * to schedule work had no path to this table. The first caller that needed one
 * — starting a crawl from the web app — would otherwise have written its own
 * insert, and two implementations of "add a job" is exactly the second path §5
 * exists to prevent. One of them would have missed the dedupe.
 *
 * @see docs/decisions/ADR-0030-worker-and-queue.md
 */

import type { Database, TenantTransaction } from './client';
import { jobs } from './schema/jobs';

export interface EnqueueInput {
  readonly name: string;
  readonly payload?: Record<string, string | number | boolean>;
  readonly runAt?: Date;
  readonly dedupeKey?: string;
}

/**
 * Enqueue a job. Returns false when `dedupeKey` matched an existing row.
 *
 * `dedupeKey` makes it idempotent: a scheduler firing twice — two workers, a
 * restart, a clock adjustment — enqueues once, because the unique index
 * refuses the second. The check is the DATABASE's, not the application's, since
 * two schedulers racing is exactly when an application check loses.
 *
 * ⚠️ ACCEPTS A TRANSACTION, AND THAT IS THE POINT (ADR-0030).
 * A job enqueued inside a transaction commits with the data that caused it. A
 * crawl row and the job that runs it are written together or not at all, so
 * there is never a job pointing at a crawl that was rolled back, and never a
 * queued crawl with nothing coming to run it.
 */
export async function enqueue(
  executor: Database | TenantTransaction,
  input: EnqueueInput,
): Promise<boolean> {
  const inserted = await executor
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
