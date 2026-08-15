import 'server-only';

/**
 * Composition root.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single place where concrete implementations are chosen and wired
 * together. Domain packages declare what they need as interfaces
 * (`RateLimiter`, `Database`); this file decides which implementation they get.
 *
 * WHY A COMPOSITION ROOT
 * Without one, `new MemoryRateLimiter()` appears in three route handlers and
 * each gets its own counters — so the rate limit silently stops working.
 * Swapping in the Redis driver (ADR-0009) is then a one-line change here
 * instead of a search across the codebase.
 *
 * The `server-only` import makes accidentally importing this from a client
 * component a BUILD error rather than a runtime secret leak.
 */

import { getDatabase, type Database } from '@growth-os/database';
import { MemoryRateLimiter, type RateLimiter, type SessionConfig } from '@growth-os/auth';
import { loadEnv, shouldUseSecureCookies, type Env } from '@growth-os/contracts/env';

export interface AppDependencies {
  readonly env: Env;
  readonly db: Database;
  readonly rateLimiter: RateLimiter;
  readonly sessionConfig: SessionConfig;
  readonly secureCookies: boolean;
  readonly loginLimits: {
    readonly perIdentifierMax: number;
    readonly perIpMax: number;
    readonly windowSeconds: number;
  };
}

/**
 * Process-wide singleton.
 *
 * Must be a singleton for correctness, not just efficiency: the in-process
 * rate limiter's counters live inside its instance, so a fresh instance per
 * request would mean no rate limiting at all.
 */
let dependencies: AppDependencies | null = null;

export function getDependencies(): AppDependencies {
  if (dependencies) return dependencies;

  const env = loadEnv();

  dependencies = {
    env,
    db: getDatabase(),
    rateLimiter: new MemoryRateLimiter(),
    sessionConfig: {
      secret: env.SESSION_SECRET,
      idleTtlSeconds: env.SESSION_IDLE_TTL,
      absoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL,
    },
    secureCookies: shouldUseSecureCookies(env),
    loginLimits: {
      perIdentifierMax: env.RATE_LIMIT_LOGIN_MAX,
      // Deliberately looser than the per-identifier limit: many legitimate
      // users share one NAT address (an office, a co-working space), so the
      // per-IP ceiling must not lock out a whole building because one person
      // mistyped their password.
      perIpMax: env.RATE_LIMIT_LOGIN_MAX * 3,
      windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
    },
  };

  return dependencies;
}

/** Test-only: inject overrides. */
export function setDependencies(overrides: Partial<AppDependencies> | null): void {
  dependencies = overrides === null ? null : { ...getDependencies(), ...overrides };
}
