/**
 * Rate limiting.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Defines the `RateLimiter` interface and the in-process sliding-window
 * implementation used today.
 *
 * ⚠️ KNOWN LIMITATION — READ BEFORE SCALING
 * `MemoryRateLimiter` counts per PROCESS. With N application instances the
 * effective limit is N× the configured value, and a restart clears all
 * counters. This is correct at the current single-instance topology and
 * MUST be replaced with a shared store before running more than one instance.
 * The interface exists precisely so that is a driver swap, not a rewrite.
 *
 * @see docs/decisions/ADR-0009-rate-limiting.md
 */

import { createHash } from 'node:crypto';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the caller may retry. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Record an attempt against `key` and report whether it is permitted. */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Clear a key. Called after a successful sign-in. */
  reset(key: string): Promise<void>;
}

/**
 * Cap on distinct tracked keys.
 *
 * Without a cap, an attacker rotating identifiers (a new email per attempt)
 * would grow the map without bound — turning the rate limiter into a memory
 * exhaustion vector, which is a worse outcome than the attack it prevents.
 */
const MAX_TRACKED_KEYS = 50_000;

/**
 * Sliding-window counter held in process memory.
 *
 * A true sliding window (retaining individual timestamps) rather than a fixed
 * window, because a fixed window permits a burst of 2× the limit across a
 * boundary — 8 attempts at 14:59 and 8 more at 15:00.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #attempts = new Map<string, number[]>();

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    const timestamps = (this.#attempts.get(key) ?? []).filter((time) => time > windowStart);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0] ?? now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + windowSeconds * 1000 - now) / 1000),
      );
      // The attempt is NOT recorded when already limited. Recording it would
      // let an attacker extend their own lockout indefinitely — and, more
      // importantly, let a third party extend a victim's by hammering their
      // identifier forever.
      this.#attempts.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    timestamps.push(now);
    this.#attempts.set(key, timestamps);

    if (this.#attempts.size > MAX_TRACKED_KEYS) this.#evict(windowStart);

    return { allowed: true, remaining: limit - timestamps.length, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    this.#attempts.delete(key);
  }

  /**
   * Drop keys whose attempts have all aged out.
   *
   * If that frees nothing (every key is currently active), evict the oldest
   * quarter by most-recent attempt. Under a deliberate key-rotation attack
   * this degrades limiting for the least-recently-seen keys rather than
   * failing the process — a bounded loss of protection beats an outage.
   */
  #evict(windowStart: number): void {
    for (const [key, timestamps] of this.#attempts) {
      const live = timestamps.filter((time) => time > windowStart);
      if (live.length === 0) this.#attempts.delete(key);
      else this.#attempts.set(key, live);
    }

    if (this.#attempts.size <= MAX_TRACKED_KEYS) return;

    const byRecency = [...this.#attempts.entries()].sort(
      (a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0),
    );
    for (const [key] of byRecency.slice(0, Math.floor(MAX_TRACKED_KEYS / 4))) {
      this.#attempts.delete(key);
    }
  }

  /** Test-only. */
  clear(): void {
    this.#attempts.clear();
  }
}

/**
 * Build the rate-limit key for an account identifier.
 *
 * The email is hashed so that neither process memory nor a future Redis
 * instance ever holds a plaintext list of the addresses people are attempting
 * to sign in with — which would be a genuinely sensitive dataset in a memory
 * dump or a compromised cache.
 */
export function identifierKey(prefix: string, identifier: string): string {
  const digest = createHash('sha256').update(identifier.toLowerCase()).digest('hex').slice(0, 32);
  return `${prefix}:${digest}`;
}

export function ipKey(prefix: string, ipAddress: string): string {
  return `${prefix}:ip:${ipAddress}`;
}
