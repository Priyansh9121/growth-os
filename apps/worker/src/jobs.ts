/**
 * The registered jobs.
 *
 * ⚠️ ONLY JOBS WITH A DECIDED RULE APPEAR HERE.
 *
 * Stage 2.5 listed four unscheduled retention items. Two had an implemented
 * function with a defined rule, and those are scheduled. The others —
 * soft-deleted contacts, `ingestion_receipts`, `audit_events` — have **no
 * decided deletion rule**, only a "target" in one case, and are deliberately
 * absent. Inventing a rule so a table looks handled is how customer data gets
 * deleted on a schedule nobody agreed to (ADR-0030 §5).
 *
 * Every handler below is IDEMPOTENT, because the queue is at-least-once: all
 * three delete rows that are already expired, so a second run finds none.
 */

import { pruneExpiredResetTokens, pruneExpiredSessions } from '@growth-os/auth';
import { pruneRateLimitWindows } from '@growth-os/forms';
import type { JobDefinition } from './queue';

const HOURLY = 3600;

export const JOBS: readonly JobDefinition[] = [
  {
    name: 'prune-expired-sessions',
    everySeconds: HOURLY,
    handler: async ({ db }) => {
      // Rule: past idle or absolute expiry. Decided in ADR-0004 and enforced
      // at read time already — this reclaims the storage.
      await pruneExpiredSessions(db);
    },
  },
  {
    name: 'prune-expired-reset-tokens',
    everySeconds: HOURLY,
    handler: async ({ db }) => {
      // Rule: expired, plus used tokens older than one further TTL. The delay
      // on used tokens is deliberate — "was this link already used?" stays
      // answerable during an incident.
      await pruneExpiredResetTokens(db);
    },
  },
  {
    name: 'prune-rate-limit-windows',
    everySeconds: HOURLY,
    handler: async ({ db, now }) => {
      // Counters from windows that can no longer be current. Nothing depends
      // on this having run — the window start is checked on read — so it is
      // pure storage reclamation and safe to miss.
      await pruneRateLimitWindows(db, new Date(now.getTime() - 24 * 3600 * 1000));
    },
  },
];

export const JOB_HANDLERS = new Map(JOBS.map((job) => [job.name, job.handler]));
