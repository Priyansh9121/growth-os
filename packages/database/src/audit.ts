/**
 * Audit event writer.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single path for writing to `audit_events`, and the enforcement point for
 * redaction.
 *
 * WHY REDACTION LIVES HERE, NOT AT CALL SITES
 * A rule of the form "remember not to log the password" is a rule that will
 * eventually be broken by someone adding a field to a metadata object at 5pm.
 * Centralising the filter means a caller *cannot* write a credential into the
 * audit trail even by accident.
 *
 * WHY WRITES NEVER THROW
 * An audit write failing must not fail the operation being audited. A user
 * whose sign-in succeeded should not receive a 500 because the audit table was
 * briefly unavailable. Failures are reported to stderr and swallowed.
 *
 * ⚠️ The tradeoff: audit records are best-effort, not guaranteed. When
 * regulatory-grade guarantees are needed (Stage 18+), this must become a
 * transactional outbox write inside the same transaction as the change it
 * describes. Recorded in docs/architecture/event-architecture.md.
 *
 * @see docs/engineering/logging.md
 */

import type { Database, TenantTransaction } from './client';
import { auditEvents, type AuditEventName } from './schema/audit';

export interface AuditEventInput {
  /**
   * The tenant this event belongs to, or `null` for platform-scoped events
   * (failed sign-ins, rate limiting) where no authenticated identity exists.
   * Null-workspace rows are invisible to tenant-scoped reads by RLS.
   */
  readonly workspaceId: string | null;
  readonly actorUserId: string | null;
  readonly eventName: AuditEventName | string;
  readonly accessPath?: 'direct' | 'agency' | 'system' | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly correlationId?: string | undefined;
}

/**
 * Keys whose values are never written, at any nesting depth.
 *
 * Matched case-insensitively as substrings, so `userPassword`,
 * `PASSWORD_HASH` and `oauth_access_token` are all caught. Over-matching is
 * the correct bias here: a redacted field that did not need redacting costs a
 * little debugging convenience, while a leaked credential costs everything.
 */
const REDACTED_KEY_PATTERNS = [
  'password',
  'token',
  'secret',
  'credential',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'session',
  'hash',
] as const;

const REDACTED = '[redacted]';

/** Bounds recursion so a cyclic or pathological object cannot hang the writer. */
const MAX_DEPTH = 4;

function shouldRedact(key: string): boolean {
  const normalised = key.toLowerCase();
  return REDACTED_KEY_PATTERNS.some((pattern) => normalised.includes(pattern));
}

/**
 * Recursively strip credential-shaped values.
 *
 * Note the deliberate exception: a key containing `session` is redacted, but
 * `sessionId` is explicitly allowed through, because a session *identifier* is
 * an opaque UUID (not the token) and is genuinely needed to correlate a login
 * with its later activity.
 */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'sessionId') {
      output[key] = item;
      continue;
    }
    output[key] = shouldRedact(key) ? REDACTED : redactMetadata(item, depth + 1);
  }
  return output;
}

/**
 * Write an audit event.
 *
 * Never throws. Pass a transaction as `executor` when the event must share a
 * transaction with the change it describes; otherwise the pooled handle is used.
 */
export async function writeAuditEvent(
  db: Database,
  input: AuditEventInput,
  executor?: TenantTransaction,
): Promise<void> {
  try {
    const target = executor ?? db;
    await target.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventName: input.eventName,
      accessPath: input.accessPath ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata:
        input.metadata === undefined
          ? null
          : (redactMetadata(input.metadata) as Record<string, unknown>),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.correlationId ?? null,
    });
  } catch (error) {
    // Deliberately swallowed — see the file header.
    console.error('[audit] failed to write event', {
      eventName: input.eventName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
