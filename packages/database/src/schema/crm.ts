/**
 * CRM schema — the commercial data foundation.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Every table here is workspace-owned, carries `workspace_id`, is indexed on
 * it, and is protected by row-level security in migration
 * `0003_crm_row_level_security.sql`. This is the checklist from
 * docs/security/tenant-isolation.md applied to seven new tables at once.
 *
 * THE THREE-ENTITY SPINE (ADR-0011)
 *   contacts      WHO this is                  — one per person
 *   acquisitions  HOW and WHERE they came from — MANY per contact
 *   opportunities WHAT deal we are pursuing    — MANY per contact
 *
 * Collapsing any pair loses information that attribution cannot reconstruct.
 * A second visit must not overwrite the first, so provenance lives on the
 * acquisition, never on the person.
 *
 * DELETION SEMANTICS DIFFER PER TABLE, BY DESIGN (ADR-0013)
 *   contacts, companies    soft delete   (identity — recoverable)
 *   opportunities          close         (a lost deal is a commercial fact)
 *   tasks                  cancel        (abandoning work is an outcome)
 *   pipelines, stages      archive       (configuration — must not orphan rows)
 *   acquisitions           none          (immutable provenance)
 *   activities             none          (append-only history)
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 * @see docs/decisions/ADR-0012-provenance-model.md
 * @see docs/decisions/ADR-0013-soft-deletion-and-retention.md
 */

import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  CURRENCIES,
  OPPORTUNITY_STATUSES,
  PROVENANCE_CONFIDENCE,
  SOURCE_PLATFORMS,
  SOURCE_TYPES,
  STAGE_CATEGORIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '@growth-os/contracts';
import { users } from './identity';
import { workspaces } from './tenancy';

/**
 * Native PostgreSQL enums, generated from the single definition in
 * `@growth-os/contracts`. Deriving them rather than restating the values means
 * the database and the application cannot drift.
 *
 * Note that `activity_type` is deliberately NOT an enum — that set grows with
 * every feature shipped, and a native enum would need a migration per addition.
 */
export const sourceTypeEnum = pgEnum('crm_source_type', SOURCE_TYPES);
export const sourcePlatformEnum = pgEnum('crm_source_platform', SOURCE_PLATFORMS);
export const provenanceConfidenceEnum = pgEnum('crm_provenance_confidence', PROVENANCE_CONFIDENCE);
export const stageCategoryEnum = pgEnum('crm_stage_category', STAGE_CATEGORIES);
export const opportunityStatusEnum = pgEnum('crm_opportunity_status', OPPORTUNITY_STATUSES);
export const taskStatusEnum = pgEnum('crm_task_status', TASK_STATUSES);
export const taskPriorityEnum = pgEnum('crm_task_priority', TASK_PRIORITIES);
export const actorTypeEnum = pgEnum('crm_actor_type', ACTOR_TYPES);
export const currencyEnum = pgEnum('crm_currency', CURRENCIES);

// ---------------------------------------------------------------------------
// companies
// ---------------------------------------------------------------------------

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /** Hostname only, lowercased. A weak identity signal, not a unique key. */
    websiteHost: text('website_host'),
    phone: text('phone'),
    phoneE164: text('phone_e164'),

    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Soft delete — identity records are recoverable (ADR-0013). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Matches the dominant query: list a workspace's live companies, newest first.
    index('companies_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('companies_workspace_name_idx').on(table.workspaceId, table.name),
  ],
);

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    firstName: text('first_name').notNull(),
    lastName: text('last_name'),

    /** As the user typed it. Preserved for display. */
    email: text('email'),
    /**
     * Trimmed and lowercased ONLY. No provider-specific rewriting: stripping
     * dots or `+aliases` applies Gmail's rules to every provider and silently
     * merges different people (ADR-0015).
     */
    emailNormalised: text('email_normalised'),

    phone: text('phone'),
    /** E.164, or NULL when unparseable. Never a mangled guess. */
    phoneE164: text('phone_e164'),

    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),

    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('contacts_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('contacts_workspace_owner_idx').on(table.workspaceId, table.ownerUserId),
    index('contacts_workspace_company_idx').on(table.workspaceId, table.companyId),

    /**
     * Identity lookup indexes, PARTIAL on live rows.
     *
     * Partial rather than unique: two family members legitimately share
     * `office@abcplumbing.test`, and an import must load duplicates rather than
     * fail on the first one. Deduplication REPORTS candidates; it never merges
     * automatically (ADR-0015).
     *
     * Restricting to `deleted_at IS NULL` also keeps the index small and means
     * an archived contact's address is immediately reusable.
     */
    index('contacts_workspace_email_idx')
      .on(table.workspaceId, table.emailNormalised)
      .where(sql`${table.deletedAt} is null and ${table.emailNormalised} is not null`),
    index('contacts_workspace_phone_idx')
      .on(table.workspaceId, table.phoneE164)
      .where(sql`${table.deletedAt} is null and ${table.phoneE164} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// acquisitions — the provenance record
// ---------------------------------------------------------------------------

export const acquisitions = pgTable(
  'acquisitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    sourceType: sourceTypeEnum('source_type').notNull(),
    sourcePlatform: sourcePlatformEnum('source_platform').notNull().default('unknown'),

    /**
     * How much this row's provenance can be trusted. NOT NULL with no default:
     * an ingestion path must state its own confidence, or every source would
     * silently claim the highest.
     */
    confidence: provenanceConfidenceEnum('confidence').notNull(),

    /** PATH only — the query string is stripped before storage (ADR-0012 §5). */
    landingPath: text('landing_path'),
    /** Origin only, never a full referring URL. */
    referrerOrigin: text('referrer_origin'),

    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmTerm: text('utm_term'),
    utmContent: text('utm_content'),

    gclid: text('gclid'),
    fbclid: text('fbclid'),

    /**
     * ⚠️ NULL unless a source system authoritatively declared it.
     *
     * Search engines have not passed the query in the referrer since 2011.
     * A value here that did not come from Search Console or an Ads platform
     * would fabricate the single number this product's value rests on.
     * Enforced by `assertProvenanceIntegrity` in @growth-os/contracts.
     */
    searchQuery: text('search_query'),

    /** The tracked number dialled, the form name, the chat widget id. */
    channelDetail: text('channel_detail'),

    /** Bounded, schema-validated extras. Not an unrestricted junk drawer. */
    metadata: jsonb('metadata').$type<Record<string, string | number | boolean>>(),

    /**
     * When this became a qualified lead. NULL = an enquiry that was never
     * judged worth pursuing. This is what makes "leads this month" a single
     * unambiguous query, rather than a matter of interpretation.
     */
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    qualifiedByUserId: uuid('qualified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    /** Server clock. A client-supplied time is a hint, never authoritative. */
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * First-touch / last-touch lookup: `MIN`/`MAX(captured_at)` per contact.
     * First-touch is deliberately NOT denormalised onto the contact — two
     * sources of truth drift the first time an import runs (ADR-0012 §7).
     */
    index('acquisitions_contact_captured_idx').on(table.contactId, table.capturedAt),
    index('acquisitions_workspace_captured_idx').on(table.workspaceId, table.capturedAt),
    // "How many leads from organic search this month?"
    index('acquisitions_workspace_source_idx').on(
      table.workspaceId,
      table.sourceType,
      table.capturedAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// pipelines and stages
// ---------------------------------------------------------------------------

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    currency: currencyEnum('currency').notNull().default('AUD'),

    /** Archive, not delete — deleting would orphan its opportunities. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pipelines_workspace_idx').on(table.workspaceId),
    /**
     * At most one default pipeline per workspace, enforced by a PARTIAL unique
     * index. Without this, "the default pipeline" becomes ambiguous and new
     * opportunities land somewhere non-deterministic.
     */
    uniqueIndex('pipelines_workspace_default_unique')
      .on(table.workspaceId)
      .where(sql`${table.isDefault} and ${table.archivedAt} is null`),
  ],
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Display order. Sparse values are fine; only relative order matters. */
    position: integer('position').notNull(),

    /**
     * Reporting semantics, separate from the name, so that win rate keeps
     * working when a workspace renames "Won" to "Job Booked".
     */
    category: stageCategoryEnum('category').notNull().default('open'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pipeline_stages_pipeline_position_idx').on(table.pipelineId, table.position),
    index('pipeline_stages_workspace_idx').on(table.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// opportunities
// ---------------------------------------------------------------------------

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),

    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),

    pipelineId: uuid('pipeline_id')
      .notNull()
      // Restrict, not cascade: deleting a pipeline must not silently destroy
      // commercial history. Pipelines archive instead (ADR-0013).
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),

    /** Mirrors the current stage's category, denormalised for cheap filtering. */
    status: opportunityStatusEnum('status').notNull().default('open'),

    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Integer MINOR units (cents). Never a float — `0.1 + 0.2` is the wrong
     * answer, and a rounding error in a pipeline total is customer-visible.
     */
    estimatedValueMinor: bigint('estimated_value_minor', { mode: 'number' }).notNull().default(0),
    currency: currencyEnum('currency').notNull().default('AUD'),

    expectedCloseOn: date('expected_close_on'),

    /**
     * THE ATTRIBUTION JOIN. Links the deal back to the acquisition that
     * produced it, so Stage 15 can trace revenue to a source without inferring
     * anything. `set null` keeps the deal if provenance is ever erased.
     */
    acquisitionId: uuid('acquisition_id').references(() => acquisitions.id, {
      onDelete: 'set null',
    }),

    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The Kanban board query: every open deal in a pipeline, by stage.
    index('opportunities_workspace_pipeline_stage_idx').on(
      table.workspaceId,
      table.pipelineId,
      table.stageId,
    ),
    index('opportunities_workspace_status_idx').on(table.workspaceId, table.status),
    index('opportunities_contact_idx').on(table.contactId),
    index('opportunities_workspace_owner_idx').on(table.workspaceId, table.ownerUserId),
  ],
);

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    description: text('description'),

    status: taskStatusEnum('status').notNull().default('open'),
    priority: taskPriorityEnum('priority').notNull().default('normal'),

    dueAt: timestamp('due_at', { withTimezone: true }),

    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Explicit relations rather than polymorphic subject_type/subject_id.
     *
     * A polymorphic reference cannot carry a foreign key, so the database
     * could not stop a task pointing at a deleted contact, and cascade
     * behaviour would have to be hand-written and remembered forever. Two
     * nullable FKs cost one column and buy referential integrity (ADR-0011 §6).
     */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),

    /**
     * Distinguishes human-created work from AI- and automation-created work.
     * Present before either exists, because retrofitting it onto a populated
     * table means guessing at history.
     */
    createdByType: actorTypeEnum('created_by_type').notNull().default('user'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByUserId: uuid('completed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "My open tasks, soonest due first" — the default Tasks view.
    index('tasks_workspace_assignee_status_idx').on(
      table.workspaceId,
      table.assignedUserId,
      table.status,
      table.dueAt,
    ),
    index('tasks_workspace_status_due_idx').on(table.workspaceId, table.status, table.dueAt),
    index('tasks_contact_idx').on(table.contactId),
    index('tasks_opportunity_idx').on(table.opportunityId),
  ],
);

// ---------------------------------------------------------------------------
// activities — the business timeline
// ---------------------------------------------------------------------------

/**
 * The customer-facing timeline. NOT the audit trail (ADR-0014).
 *
 * `activities` answers "what happened with this customer?" and deliberately
 * contains PII. `audit_events` answers "who changed our data?" and deliberately
 * does not. One user action commonly writes both, in one transaction.
 *
 * Append-only: no UPDATE or DELETE policy is created for it, and with RLS
 * enabled an operation with no matching policy is denied. The absence of the
 * policy IS the control.
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** `entity.past_tense_verb`. TEXT, not an enum — this set grows constantly. */
    type: text('type').notNull(),

    /** One line, rendered directly on the timeline. */
    summary: text('summary').notNull(),
    /** Optional longer body — a note's contents, a call transcript summary. */
    detail: text('detail'),

    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    acquisitionId: uuid('acquisition_id').references(() => acquisitions.id, {
      onDelete: 'set null',
    }),

    actorType: actorTypeEnum('actor_type').notNull().default('user'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Bounded structured context. Same redaction rules as the audit writer. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    /**
     * When the business event happened — which is not always when the row was
     * written. A call imported an hour later occurred when the call occurred.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The contact timeline: newest first, for one person.
    index('activities_contact_occurred_idx').on(table.contactId, table.occurredAt),
    index('activities_opportunity_occurred_idx').on(table.opportunityId, table.occurredAt),
    index('activities_workspace_occurred_idx').on(table.workspaceId, table.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// invitations
// ---------------------------------------------------------------------------

/**
 * Workspace invitations (ADR-0018).
 *
 * Tokens are stored ONLY as `SHA-256(HMAC(token, SESSION_SECRET))` — the same
 * construction as sessions — so a read-only database leak yields no usable
 * invitations to any pending workspace.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Normalised, so an invite matches regardless of how it was typed. */
    emailNormalised: text('email_normalised').notNull(),

    /** The role granted on acceptance. Never stronger than the inviter's own. */
    role: text('role').notNull(),

    tokenHash: text('token_hash').notNull(),

    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set inside the accepting transaction — this is what makes it single-use. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_unique').on(table.tokenHash),
    index('invitations_workspace_idx').on(table.workspaceId),
    /**
     * One live invitation per email per workspace. Partial, so a revoked or
     * accepted invite does not block re-inviting the same person later.
     */
    uniqueIndex('invitations_workspace_email_pending_unique')
      .on(table.workspaceId, table.emailNormalised)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
  ],
);

export type CompanyRow = typeof companies.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type AcquisitionRow = typeof acquisitions.$inferSelect;
export type PipelineRow = typeof pipelines.$inferSelect;
export type PipelineStageRow = typeof pipelineStages.$inferSelect;
export type OpportunityRow = typeof opportunities.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
