/**
 * Append-only audit trail.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * `audit_events` is the first tenant-scoped table in Growth OS, and it is
 * deliberately the one that establishes the row-level security pattern every
 * future tenant table copies. Getting the pattern right once, on a table whose
 * contents are non-critical, is much safer than discovering it for the first
 * time on `contacts`.
 *
 * WHY AN AUDIT TRAIL EXISTS AT STAGE 1
 * Three reasons, all of which get harder to satisfy later:
 *  1. Agencies operate client workspaces on their behalf. "Who did this?" must
 *     be answerable, and must distinguish the client's own admin from their
 *     agency.
 *  2. Security incidents are investigated with data recorded BEFORE the
 *     incident. Adding auditing after a breach answers nothing about it.
 *  3. AI actions (Stage 7+) must be attributable to the agent, the run and the
 *     human who authorised them.
 *
 * @see docs/security/tenant-isolation.md
 * @see docs/architecture/multi-tenancy.md
 */

import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { workspaces } from './tenancy';

/**
 * Canonical event names, `domain.entity.past_tense_verb`.
 *
 * A plain union rather than a PostgreSQL enum: audit event names will be added
 * constantly as features ship, and a native enum would require a migration for
 * every single one. The tradeoff is that the database does not constrain the
 * value — accepted because this column is descriptive, not load-bearing for
 * any authorization decision.
 */
export const AUDIT_EVENTS = {
  AUTH_LOGIN_SUCCEEDED: 'auth.session.created',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.session.revoked',
  AUTH_RATE_LIMITED: 'auth.login.rate_limited',
  TENANCY_ACCESS_DENIED: 'tenancy.access.denied',
  TENANCY_WORKSPACE_SWITCHED: 'tenancy.workspace.switched',
  AI_QUERY_SUBMITTED: 'ai.query.submitted',

  // CRM (Stage 2). These are the SECURITY record of data changes — distinct
  // from the CRM activity timeline, which is the business record and contains
  // PII. One user action commonly writes both (ADR-0014).
  CRM_CONTACT_CREATED: 'crm.contact.created',
  CRM_CONTACT_UPDATED: 'crm.contact.updated',
  CRM_CONTACT_ARCHIVED: 'crm.contact.archived',
  CRM_OPPORTUNITY_CREATED: 'crm.opportunity.created',
  CRM_OPPORTUNITY_STAGE_CHANGED: 'crm.opportunity.stage_changed',
  CRM_INVITATION_CREATED: 'crm.invitation.created',
  CRM_INVITATION_ACCEPTED: 'crm.invitation.accepted',
  CRM_INVITATION_REVOKED: 'crm.invitation.revoked',

  // Data lifecycle (Stage 2.5). Both are irreversible and privileged, so both
  // are recorded here in addition to the business timeline — and neither
  // record carries the values involved. An audit trail that preserved the
  // erased name would defeat the erasure (ADR-0020 §5).
  CRM_CONTACT_MERGED: 'crm.contact.merged',
  CRM_CONTACT_ERASED: 'crm.contact.erased',
  CRM_CONTACTS_IMPORTED: 'crm.contacts.imported',
  CRM_CUSTOM_FIELD_DEFINED: 'crm.custom_field.defined',
  CRM_CUSTOM_FIELD_ARCHIVED: 'crm.custom_field.archived',
} as const;

export type AuditEventName = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The tenancy boundary column, and the column the RLS policy filters on.
     *
     * Nullable because some auditable events happen before a workspace is
     * known — most importantly a failed sign-in, where we do not yet have (and
     * must not infer) an authenticated identity. Rows with a null
     * `workspace_id` are platform-scoped and are NOT visible under the tenant
     * RLS policy, which is the correct default: a tenant should not read
     * platform-level security events.
     */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),

    /**
     * The acting user, when known.
     *
     * `onDelete: 'set null'` deliberately: the audit record must survive the
     * deletion of the user it describes, otherwise deleting an account erases
     * the evidence of what that account did.
     */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    eventName: text('event_name').notNull(),

    /**
     * How the actor reached this workspace: `direct` | `agency` | `system`.
     * Stage 16 requires agency-performed actions to be distinguishable from
     * the client's own — this column is how.
     */
    accessPath: text('access_path'),

    /** Optional target, e.g. the ID of the record that changed. */
    targetType: text('target_type'),
    targetId: text('target_id'),

    /**
     * Structured context.
     *
     * MUST NOT contain credentials, session tokens, password material or full
     * request bodies. Redaction is enforced by the writer in
     * `packages/database/src/audit.ts`, not left to call sites — a rule that
     * depends on every caller remembering it is a rule that will be broken.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    /**
     * Recorded for incident investigation. Personal data under GDPR, so it is
     * subject to the retention policy documented in
     * docs/security/secure-development.md.
     */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    /** Ties an audit record to the request that produced it, and to the logs. */
    correlationId: text('correlation_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The workspace audit view: newest first, scoped to one tenant.
    index('audit_events_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('audit_events_actor_idx').on(table.actorUserId),
    // "Show me every failed login in the last hour" during an incident.
    index('audit_events_name_created_idx').on(table.eventName, table.createdAt),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
