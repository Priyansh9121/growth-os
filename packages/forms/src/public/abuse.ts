/**
 * Public submission abuse controls.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Deciding whether an anonymous submission should be processed at all. This is
 * core architecture for a public endpoint, not polish — the alternative to
 * having it is a customer's CRM filling with spam and their sales team learning
 * to ignore new leads.
 *
 * THE GOVERNING PRINCIPLE: SIGNALS, NOT A SINGLE HEURISTIC
 * Every individual check here is defeatable. A honeypot catches naive fillers;
 * timing catches scripts that submit instantly; rate limits catch volume.
 * Each is cheap and weak, and the design assumes so. Nothing here is described
 * as "bot detection".
 *
 * THE COST OF A FALSE POSITIVE IS HIGHER THAN A FALSE NEGATIVE
 * A rejected spam submission costs nothing. A rejected real enquiry is a lost
 * customer the business never learns about. So every threshold is set loose,
 * and the timing check in particular is deliberately generous — a keyboard-
 * fluent person using autofill genuinely does submit a short form in three
 * seconds, and blocking them to catch a bot is a bad trade.
 *
 * @see docs/security/public-forms-threat-model.md
 */

import { createHash } from 'node:crypto';
import { lt, sql } from 'drizzle-orm';
import type { RejectionReason } from '@growth-os/contracts';
import { schemaTables, withUnscopedTransaction, type Database } from '@growth-os/database';

const { publicSubmissionLimits } = schemaTables;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitRule {
  readonly max: number;
  readonly windowSeconds: number;
}

/**
 * The public submission limits.
 *
 * Chosen against what a real business actually receives. A busy plumber gets
 * perhaps twenty enquiries a day; a form receiving 200 in an hour is either
 * viral or under attack, and both deserve a look. The per-IP limit is much
 * tighter because one household submitting twenty enquiries an hour to one form
 * is not a household.
 */
export const PUBLIC_LIMITS = {
  /** One address, one form. The tightest, and the one spam hits first. */
  perIpPerForm: { max: 5, windowSeconds: 3600 },
  /** One address across every form. Catches a sweep across a workspace. */
  perIp: { max: 20, windowSeconds: 3600 },
  /** One form from everywhere. Catches a distributed flood. */
  perForm: { max: 200, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * The burst tier: in-process, no I/O.
 *
 * Runs FIRST, so a flood is refused before it can amplify into database
 * writes. The durable tier below is only consulted by requests that already
 * passed this one.
 *
 * ⚠️ PER-PROCESS. With one application instance — which is what Growth OS runs
 * today — this is genuinely effective. With several it becomes per-instance,
 * which is why the durable tier exists and carries the real guarantee
 * (ADR-0030 §3).
 */
class BurstLimiter {
  private readonly hits = new Map<string, number[]>();
  /** Bounds memory against an attacker rotating keys. */
  private static readonly MAX_KEYS = 20_000;

  allow(key: string, max: number, windowMs: number, now: number): boolean {
    if (this.hits.size > BurstLimiter.MAX_KEYS) this.hits.clear();

    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

const burst = new BurstLimiter();

/** 5 submissions per 10 seconds from one address. A human cannot type that fast. */
const BURST_MAX = 5;
const BURST_WINDOW_MS = 10_000;

/**
 * Hash a rate-limit subject.
 *
 * ⚠️ THE IP IS NEVER STORED. `public_submission_limits` holds this hash, so an
 * operator with database access cannot read the addresses of a customer's
 * website visitors out of the rate limiter.
 */
export function subjectHash(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly scope: string | null;
}

/**
 * Consume one submission against every applicable limit.
 *
 * Runs unscoped: rate limiting happens per IP and per form, neither of which is
 * a tenant, and the table holds no tenant data.
 */
export async function consumePublicRateLimit(
  db: Database,
  input: { ipAddress: string; formId: string; now: Date },
): Promise<RateLimitVerdict> {
  const { ipAddress, formId, now } = input;

  // Tier 1: burst, in memory, before any I/O.
  if (!burst.allow(`${ipAddress}:${formId}`, BURST_MAX, BURST_WINDOW_MS, now.getTime())) {
    return { allowed: false, scope: 'burst' };
  }

  // Tier 2: durable, shared across instances and across restarts.
  const checks: readonly (readonly [string, string, RateLimitRule])[] = [
    ['ip_form', `${ipAddress}|${formId}`, PUBLIC_LIMITS.perIpPerForm],
    ['ip', ipAddress, PUBLIC_LIMITS.perIp],
    ['form', formId, PUBLIC_LIMITS.perForm],
  ];

  return withUnscopedTransaction(db, async (tx) => {
    for (const [scope, value, rule] of checks) {
      const hash = subjectHash(scope, value);
      const windowStart = new Date(
        Math.floor(now.getTime() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000,
      );
      // ⚠️ An ISO STRING with an explicit cast, not the Date.
      //
      // Drizzle's typed builders serialise a `Date` correctly; a raw `sql`
      // template does NOT — postgres.js binds it and the driver throws
      // "argument must be of type string". Third occurrence of this class in
      // the codebase, after `= any(${jsArray})` twice, and it is always found
      // at runtime rather than by the type system.
      const windowStartParam = windowStart.toISOString();

      // Upsert-and-read in one statement. A read-then-write races under
      // exactly the concurrent traffic a rate limiter exists for.
      //
      // The window start is part of the conflict resolution: a row from an
      // older window resets rather than accumulating, so nothing depends on a
      // sweep job having run.
      const [row] = await tx
        .insert(publicSubmissionLimits)
        .values({ subjectHash: hash, windowStartedAt: windowStart, count: 1 })
        .onConflictDoUpdate({
          target: publicSubmissionLimits.subjectHash,
          set: {
            count: sql`case
              when ${publicSubmissionLimits.windowStartedAt} < ${windowStartParam}::timestamptz then 1
              else ${publicSubmissionLimits.count} + 1 end`,
            windowStartedAt: windowStart,
          },
        })
        .returning({ count: publicSubmissionLimits.count });

      if ((row?.count ?? 0) > rule.max) return { allowed: false, scope };
    }

    return { allowed: true, scope: null };
  });
}

/**
 * Delete counters from windows that can no longer be current. Worker job.
 *
 * ⚠️ `lt()` rather than a raw `sql` template. A `Date` bound inside a raw
 * template is not serialised by postgres.js and throws at runtime — the FOURTH
 * occurrence of this class in the codebase, and the first one a scheduled job
 * hit rather than a test. Drizzle's typed comparators handle the conversion;
 * raw templates need an explicit ISO string and a cast.
 *
 * Nothing depends on this having run: the window start is re-checked on every
 * read, so a missed sweep costs storage and never correctness.
 */
export async function pruneRateLimitWindows(db: Database, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(publicSubmissionLimits)
    .where(lt(publicSubmissionLimits.windowStartedAt, olderThan))
    .returning({ subjectHash: publicSubmissionLimits.subjectHash });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// Content signals
// ---------------------------------------------------------------------------

export interface AbuseSignalInput {
  readonly honeypotEnabled: boolean;
  readonly honeypotKey: string | null;
  readonly trap: string | undefined;
  readonly elapsedMs: number | undefined;
  readonly minSubmitSeconds: number;
}

/**
 * Evaluate the cheap content signals.
 *
 * Returns the reason for the OPERATOR. The public response never distinguishes
 * these — telling a bot which signal caught it is telling it what to change.
 */
export function evaluateAbuseSignals(input: AbuseSignalInput): RejectionReason | null {
  // A hidden field with a value means something filled every input it found.
  if (input.honeypotEnabled && input.honeypotKey !== null) {
    if (typeof input.trap === 'string' && input.trap.trim().length > 0) {
      return 'honeypot';
    }
  }

  // Timing. Only applied when the client actually reported an elapsed time —
  // an absent value is NOT treated as suspicious, because the tracking script
  // may legitimately be blocked and a form must work without it.
  if (input.elapsedMs !== undefined && input.minSubmitSeconds > 0) {
    if (input.elapsedMs < input.minSubmitSeconds * 1000) return 'too_fast';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Challenge provider
// ---------------------------------------------------------------------------

/**
 * A CAPTCHA/Turnstile provider seam.
 *
 * An interface because no provider is configured, and because hardwiring one
 * would make swapping it a code change in the submission path rather than a
 * constructor argument. Same shape as the notifier seams in auth.
 *
 * ⚠️ A provider's SECRET never reaches browser code. The browser gets a site
 * key and returns an opaque token; verification happens here, server-side.
 */
export interface SubmissionChallengeVerifier {
  /** `true` when the token is valid, or when no challenge is required. */
  verify(token: string | undefined, context: { ipAddress: string }): Promise<boolean>;
}

/**
 * Development and default: no challenge.
 *
 * Accepts everything, and says so in its name — unlike a silent pass-through,
 * which would let "we have CAPTCHA" become true in conversation and false in
 * production. The rate limits and content signals are what actually run today.
 */
export class NoChallengeVerifier implements SubmissionChallengeVerifier {
  async verify(): Promise<boolean> {
    return true;
  }
}
