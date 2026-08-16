/**
 * The worker process.
 *
 * A LOOP, not a service. It polls, runs what it finds, and sleeps. There is no
 * HTTP server here and there must not be one — that is the line between a
 * second process and a second service (ADR-0001).
 *
 * Run it with:
 *
 *   npm run worker            long-running
 *   npm run worker -- --once  a single pass, for CI and tests
 *
 * The `--once` mode matters more than it looks: it is how the test suite
 * exercises real scheduling without waiting real hours, and how CI proves the
 * worker boots and drains a queue rather than only that it compiles.
 */

import { closeDatabase, getDatabase } from '@growth-os/database';
import { JOBS, JOB_HANDLERS } from './jobs';
import { claimJobs, completeJob, failJob, reclaimStalledJobs, scheduleRecurring } from './queue';

/** How long to sleep when there was nothing to do. */
const IDLE_MS = 5_000;
/** Jobs claimed per pass. Small: these are infrequent, not throughput work. */
const BATCH = 5;
/** A job still `running` after this is assumed abandoned by a dead worker. */
const STALLED_MS = 10 * 60 * 1000;

const db = getDatabase();
let running = true;

/**
 * One pass: reclaim, schedule, drain.
 *
 * Returns how many jobs ran, so the loop can sleep when idle rather than
 * spinning — and so `--once` can report something useful.
 */
export async function runOnce(now = new Date()): Promise<number> {
  await reclaimStalledJobs(db, new Date(now.getTime() - STALLED_MS));
  await scheduleRecurring(db, JOBS, now);

  const claimed = await claimJobs(db, BATCH, now);

  for (const job of claimed) {
    const handler = JOB_HANDLERS.get(job.name);

    if (!handler) {
      // An unknown job name is a deploy skew — a job enqueued by a newer build
      // than this worker. Failing it is correct and visible; silently dropping
      // it would lose the work with no record.
      await failJob(db, job, new Error(`No handler registered for "${job.name}"`), now);
      continue;
    }

    try {
      await handler({ db, payload: job.payload ?? {}, now });
      await completeJob(db, job.id, now);
      // Job NAMES only. A payload may carry identifiers, and a log line is a
      // fan-out surface like an event.
      console.info('[worker] completed', { job: job.name, attempt: job.attempts });
    } catch (error) {
      await failJob(db, job, error, now);
      console.error('[worker] failed', {
        job: job.name,
        attempt: job.attempts,
        willRetry: job.attempts < job.maxAttempts,
      });
    }
  }

  return claimed.length;
}

/**
 * Stop accepting new work. Exported so a test can drive shutdown without
 * sending a real signal to its own process.
 */
export function requestShutdown(): void {
  running = false;
}

/**
 * The worker's lifecycle.
 *
 * ⚠️ THE WORKER OWNS THE PROCESS-WIDE DATABASE POOL, and is therefore the one
 * thing that closes it (see the ownership note on `getDatabase`). Without that,
 * `--once` did all of its work correctly and then **hung forever** — the pass
 * completed, nothing was left to do, and an idle pooled connection held the
 * event loop open with no indication anything was wrong.
 *
 * The `finally` is what makes this a finite program. There is deliberately no
 * `process.exit()`: forcing exit would hide the ownership bug rather than fix
 * it, and would sever an in-flight transaction instead of letting it settle.
 */
async function main(): Promise<void> {
  const once = process.argv.includes('--once');

  console.info('[worker] starting', {
    mode: once ? 'once' : 'loop',
    jobs: JOBS.map((job) => job.name),
  });

  // Registered BEFORE the loop, and for both modes, so a signal arriving
  // during a long first pass is not lost.
  //
  // The handler sets a flag rather than exiting: a job interrupted between
  // finishing its work and writing its `completed` row would be reclaimed and
  // run again — safe, because handlers are idempotent, but pointless.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.info('[worker] stopping after the current pass');
      requestShutdown();
    });
  }

  try {
    if (once) {
      const ran = await runOnce();
      console.info('[worker] pass complete', { ran });
      return;
    }

    while (running) {
      const ran = await runOnce();
      if (ran === 0 && running) await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    }
  } finally {
    // Runs on the happy path, on a signal, AND on a fatal error — the three
    // ways this process ends. Closing the pool releases the event loop and the
    // process exits naturally, with its own exit code intact.
    await closeDatabase(db);
    console.info('[worker] stopped');
  }
}

// `import.meta.main` is not available in this Node/tsx combination, so the
// entry point is guarded by argv instead — the module is importable by tests
// without starting a loop.
if (process.argv[1]?.includes('main.ts')) {
  main().catch((error: unknown) => {
    console.error('[worker] fatal', error);
    // `exitCode`, never `process.exit()`. Setting the code lets Node finish
    // draining and exit on its own — the pool is already closed by the
    // `finally` above, so there is nothing left holding it open.
    process.exitCode = 1;
  });
}
