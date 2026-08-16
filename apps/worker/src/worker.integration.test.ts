/**
 * The worker — queue semantics and process lifecycle.
 *
 * WHY THIS SUITE EXISTS
 * Three bugs shipped into this file's subject before it was written, and all
 * three were invisible to every other layer:
 *
 *  1. `--once` never returned. The pass finished, and an idle pooled
 *     connection held the event loop open forever.
 *  2. A pass could not claim the jobs it had just scheduled, because `enqueue`
 *     stamped `run_at` a few milliseconds after the `now` the pass filtered
 *     with. Loop mode hid it by self-correcting on the next tick.
 *  3. A retention job threw at runtime on a `Date` bound into a raw SQL
 *     template, retried five times, and went terminally `failed` — with
 *     nothing but a row in a table to say so.
 *
 * Each has a test below. A queue whose failures are silent is worse than no
 * queue, because the work looks done.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  closeDatabase,
  createDatabase,
  hasTestDatabase,
  schemaTables,
  type Database,
} from '@growth-os/database';
import {
  claimJobs,
  completeJob,
  enqueue,
  failJob,
  reclaimStalledJobs,
  scheduleRecurring,
  type JobDefinition,
} from './queue';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { jobs } = schemaTables;

describeIntegration('worker queue', () => {
  let db: Database;

  beforeAll(() => {
    // Its OWN handle, not the process-wide singleton: this suite closes what
    // it opens, and closing a shared pool would break every other suite in the
    // run (see the ownership note on `getDatabase`).
    db = createDatabase({ connectionString: process.env['TEST_DATABASE_URL']!, maxConnections: 3 });
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await db.delete(jobs);
  });

  afterEach(async () => {
    await db.delete(jobs);
  });

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  describe('scheduling', () => {
    const definitions: readonly JobDefinition[] = [
      { name: 'test-hourly', everySeconds: 3600, handler: async () => {} },
      { name: 'test-on-demand', handler: async () => {} },
    ];

    it('⚠️ schedules jobs a pass can immediately claim', async () => {
      // REGRESSION. `enqueue` used to default `run_at` to its own `new Date()`,
      // a few milliseconds after the pass's `now` — so `run_at <= now` excluded
      // everything the pass had just scheduled and it claimed nothing. A
      // `--once` run reported a clean pass having done no work at all.
      const now = new Date();

      await scheduleRecurring(db, definitions, now);
      const claimed = await claimJobs(db, 10, now);

      expect(claimed.map((job) => job.name)).toEqual(['test-hourly']);
    });

    it('does not schedule a job with no interval', async () => {
      await scheduleRecurring(db, definitions, new Date());
      const rows = await db.select().from(jobs);

      // `test-on-demand` has no `everySeconds` and is enqueued by a caller.
      expect(rows.map((row) => row.name)).toEqual(['test-hourly']);
    });

    it('enqueues once per window however many times it is called', async () => {
      const now = new Date();

      // Two workers, a restart, a clock adjustment — all the same window.
      await scheduleRecurring(db, definitions, now);
      await scheduleRecurring(db, definitions, now);
      await scheduleRecurring(db, definitions, new Date(now.getTime() + 60_000));

      // The DATABASE enforces this through the unique index, not application
      // code — two schedulers racing is exactly when an application check loses.
      expect(await db.select().from(jobs)).toHaveLength(1);
    });

    it('enqueues again in the next window', async () => {
      const now = new Date();
      await scheduleRecurring(db, definitions, now);
      await scheduleRecurring(db, definitions, new Date(now.getTime() + 3600_000));

      expect(await db.select().from(jobs)).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Claiming
  // -------------------------------------------------------------------------

  describe('claiming', () => {
    it('does not claim a job whose time has not come', async () => {
      const now = new Date();
      await enqueue(db, { name: 'later', runAt: new Date(now.getTime() + 60_000) });

      expect(await claimJobs(db, 10, now)).toHaveLength(0);
    });

    it('claims oldest first, and respects the batch limit', async () => {
      const now = new Date();
      for (let i = 0; i < 5; i += 1) {
        await enqueue(db, {
          name: `job-${i}`,
          runAt: new Date(now.getTime() - (5 - i) * 1000),
          dedupeKey: `job-${i}`,
        });
      }

      const claimed = await claimJobs(db, 2, now);

      // WHICH jobs are claimed is the guarantee; the ORDER they come back in
      // is not. `UPDATE … RETURNING` emits rows in the order it updated them,
      // which need not match the subquery's `ORDER BY` — and does not need to,
      // because fairness comes from the SELECTION (oldest `run_at` first) and
      // the worker processes the batch sequentially regardless.
      //
      // Asserted as a set so nobody later "fixes" this by adding an outer
      // ORDER BY that changes nothing.
      expect(new Set(claimed.map((job) => job.name))).toEqual(new Set(['job-0', 'job-1']));
      expect(claimed).toHaveLength(2);
    });

    it('claims each job exactly once under concurrency', async () => {
      const now = new Date();
      for (let i = 0; i < 6; i += 1) {
        await enqueue(db, { name: `c-${i}`, runAt: now, dedupeKey: `c-${i}` });
      }

      // `FOR UPDATE SKIP LOCKED` is the whole design: each caller takes rows
      // nothing else holds and skips the rest, so no job is claimed twice and
      // neither caller blocks.
      const [a, b, c] = await Promise.all([
        claimJobs(db, 3, now),
        claimJobs(db, 3, now),
        claimJobs(db, 3, now),
      ]);

      const names = [...a, ...b, ...c].map((job) => job.name);
      expect(names).toHaveLength(6);
      expect(new Set(names).size).toBe(6);
    });

    it('increments attempts when it claims', async () => {
      const now = new Date();
      await enqueue(db, { name: 'counted', runAt: now });

      const [claimed] = await claimJobs(db, 1, now);
      expect(claimed?.attempts).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure
  // -------------------------------------------------------------------------

  describe('failure handling', () => {
    it('retries with backoff, then fails terminally', async () => {
      const now = new Date();
      await enqueue(db, { name: 'flaky', runAt: now, dedupeKey: 'flaky' });

      let claimed = (await claimJobs(db, 1, now))[0]!;
      await failJob(db, { ...claimed, maxAttempts: 2 }, new Error('boom'), now);

      let [row] = await db.select().from(jobs).where(eq(jobs.name, 'flaky'));
      expect(row?.status).toBe('pending');
      // Backoff, so the retry is not immediate.
      expect(row!.runAt.getTime()).toBeGreaterThan(now.getTime());

      claimed = (await claimJobs(db, 1, new Date(now.getTime() + 3600_000)))[0]!;
      await failJob(db, { ...claimed, maxAttempts: 2 }, new Error('boom'), now);

      [row] = await db.select().from(jobs).where(eq(jobs.name, 'flaky'));
      // A job that cannot succeed stops consuming capacity and starts being
      // visible, rather than retrying forever.
      expect(row?.status).toBe('failed');
      expect(row?.lastError).toContain('boom');
    });

    it('truncates the recorded error', async () => {
      const now = new Date();
      await enqueue(db, { name: 'verbose', runAt: now });
      const claimed = (await claimJobs(db, 1, now))[0]!;

      // A driver error can quote the row that caused it, and a job payload is
      // not somewhere PII should reach a log column.
      await failJob(db, claimed, new Error('x'.repeat(5000)), now);

      const [row] = await db.select().from(jobs).where(eq(jobs.name, 'verbose'));
      expect(row!.lastError!.length).toBeLessThanOrEqual(500);
    });

    it('cannot record more attempts than its ceiling', async () => {
      // Enforced by a CHECK constraint, not by the code that increments it.
      await expect(
        db.execute(sql`insert into jobs (name, attempts, max_attempts) values ('over', 9, 3)`),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Stalled recovery
  // -------------------------------------------------------------------------

  describe('stalled recovery', () => {
    it('returns a job abandoned by a dead worker', async () => {
      const now = new Date();
      await enqueue(db, { name: 'abandoned', runAt: now });
      await claimJobs(db, 1, now);

      // A worker killed mid-job leaves the row `running` forever. This is what
      // makes the queue at-least-once — and why handlers must be idempotent.
      const reclaimed = await reclaimStalledJobs(db, new Date(now.getTime() + 60_000));

      expect(reclaimed).toBe(1);
      const [row] = await db.select().from(jobs).where(eq(jobs.name, 'abandoned'));
      expect(row?.status).toBe('pending');
      expect(row?.claimedAt).toBeNull();
    });

    it('does not disturb a job that is merely slow', async () => {
      const now = new Date();
      await enqueue(db, { name: 'slow', runAt: now });
      await claimJobs(db, 1, now);

      // Reclaiming a running job would run it twice concurrently.
      expect(await reclaimStalledJobs(db, new Date(now.getTime() - 60_000))).toBe(0);
    });
  });

  it('marks a completed job completed', async () => {
    const now = new Date();
    await enqueue(db, { name: 'done', runAt: now });
    const claimed = (await claimJobs(db, 1, now))[0]!;

    await completeJob(db, claimed.id, now);

    const [row] = await db.select().from(jobs).where(eq(jobs.name, 'done'));
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

describeIntegration('database lifecycle', () => {
  it('closing releases the pool, and is idempotent', async () => {
    const db = createDatabase({
      connectionString: process.env['TEST_DATABASE_URL']!,
      maxConnections: 2,
    });
    await db.execute(sql`select 1`);

    await closeDatabase(db);
    // A second close finds nothing registered and returns — the registry entry
    // is removed BEFORE the await, so even a concurrent call is a no-op.
    await expect(closeDatabase(db)).resolves.toBeUndefined();
  });

  it('does not throw when there is nothing to close', async () => {
    // A shutdown path that fails while shutting down turns a clean exit into a
    // crash.
    await expect(closeDatabase(null)).resolves.toBeUndefined();
    await expect(closeDatabase(undefined)).resolves.toBeUndefined();
  });

  it('survives concurrent closes', async () => {
    const db = createDatabase({
      connectionString: process.env['TEST_DATABASE_URL']!,
      maxConnections: 2,
    });
    await db.execute(sql`select 1`);

    await expect(
      Promise.all([closeDatabase(db), closeDatabase(db), closeDatabase(db)]),
    ).resolves.toHaveLength(3);
  });

  it('a closed handle refuses further queries rather than silently reconnecting', async () => {
    const db = createDatabase({
      connectionString: process.env['TEST_DATABASE_URL']!,
      maxConnections: 2,
    });
    await db.execute(sql`select 1`);
    await closeDatabase(db);

    // The point of closing is that the resource is gone. A handle that
    // transparently reopened would make "did I close it?" unanswerable, and
    // would resurrect the event-loop leak this whole mechanism exists to fix.
    await expect(db.execute(sql`select 1`)).rejects.toThrow();
  });
});
