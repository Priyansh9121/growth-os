/**
 * Lead capture forms.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The configuration an anonymous browser renders and submits against, and the
 * mapping that turns what it typed into a CRM contact.
 *
 * THE VERSIONING PROBLEM, AND WHY IT IS SOLVED THIS WAY
 * A lead submitted under version 3 must not silently mean something different
 * after version 4 remaps a field. If "Field 2" was `phone` on Monday and
 * `company` on Tuesday, a submission recorded on Monday is uninterpretable by
 * Wednesday.
 *
 * Solved by making the CONFIGURATION immutable and the FORM a pointer:
 *
 *   forms                identity, public key, status, current version
 *   form_versions        an immutable snapshot of fields and settings
 *   form_submissions     records which VERSION it was submitted under
 *
 * Editing a published form creates a new version rather than mutating one.
 * That also makes "what did this form look like when that lead arrived?"
 * answerable, which matters the first time a customer disputes a lead's source.
 *
 * WHY FIELDS ARE JSONB ON THE VERSION, NOT A TABLE
 * Deliberate, and the opposite of the ADR-0022 decision for custom fields —
 * so the difference is worth stating. Custom field VALUES are queried,
 * filtered, and must be enumerable by erasure, which is why they are rows. A
 * form's field LIST is read as a whole, written as a whole, versioned as a
 * whole, and never queried across forms. It has no independent identity.
 * Splitting it into rows would buy nothing and would make an immutable version
 * snapshot a multi-table write.
 *
 * The shape is still validated: `formVersionConfigSchema` in contracts parses
 * it on the way in and on the way out.
 *
 * @see docs/decisions/ADR-0026-public-form-resolution.md
 * @see docs/architecture/lead-capture-architecture.md
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  FORM_STATUSES,
  SUBMISSION_OUTCOMES,
  type FormFieldConfig,
  type FormSettingsConfig,
} from '@growth-os/contracts';
import { users } from './identity';
import { workspaces } from './tenancy';
import { sites } from './sites';
import { acquisitions, contacts, opportunities } from './crm';

export const formStatusEnum = pgEnum('form_status', FORM_STATUSES);
export const submissionOutcomeEnum = pgEnum('form_submission_outcome', SUBMISSION_OUTCOMES);

// ---------------------------------------------------------------------------
// forms
// ---------------------------------------------------------------------------

export const forms = pgTable(
  'forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /**
     * THE PUBLIC IDENTIFIER. 32 hex characters, 128 bits from
     * `crypto.randomBytes`.
     *
     * Globally unique, because it is resolved WITHOUT a workspace scope — the
     * anonymous caller has no tenant context, so the key alone must identify
     * exactly one form (ADR-0026).
     *
     * NOT A SECRET and NOT AUTHENTICATION. It appears in embed code and in a
     * URL. Every security property must hold with it fully public; what it
     * grants is the ability to submit to one form, and nothing else.
     */
    publicKey: text('public_key').notNull(),

    status: formStatusEnum('status').notNull().default('draft'),

    /**
     * The version an anonymous visitor currently renders and submits against.
     *
     * NULL while a form has never been published. A draft with no published
     * version accepts nothing, which is the correct default rather than an
     * edge case.
     */
    publishedVersionId: uuid('published_version_id').references(
      (): AnyPgColumn => formVersions.id,
      { onDelete: 'set null' },
    ),

    /** Optional owning site, for allowed-origin defaults. Leads outlive it. */
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),

    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('forms_public_key_unique').on(table.publicKey),
    index('forms_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('forms_site_idx').on(table.siteId),
  ],
);

// ---------------------------------------------------------------------------
// form_versions
// ---------------------------------------------------------------------------

/**
 * An immutable configuration snapshot.
 *
 * Never updated after creation — there is no UPDATE policy on this table, the
 * same mechanism that makes `activities` append-only (ADR-0014). Editing a
 * form writes a new row.
 */
export const formVersions = pgTable(
  'form_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references((): AnyPgColumn => forms.id, { onDelete: 'cascade' }),

    /** 1, 2, 3… per form. Shown to operators; a submission records it. */
    version: integer('version').notNull(),

    /**
     * The ordered field list. Validated by `formVersionConfigSchema` on write
     * AND on read — a row written by an older build must still parse, or the
     * public form fails closed rather than rendering something unintended.
     */
    fields: jsonb('fields').$type<readonly FormFieldConfig[]>().notNull(),

    /** Success behaviour, opportunity rule, theme, abuse settings. */
    settings: jsonb('settings').$type<FormSettingsConfig>().notNull(),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('form_versions_form_version_unique').on(table.formId, table.version),
    index('form_versions_workspace_idx').on(table.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// form_submissions
// ---------------------------------------------------------------------------

/**
 * A RECEIPT, not an archive.
 *
 * ⚠️ THIS TABLE DOES NOT STORE WHAT THE VISITOR TYPED.
 *
 * Stage 2.5 established that a table holding raw payloads is a shadow PII
 * store — outside erasure's reach, invisible to retention policy, and a second
 * copy of customer data in a table nobody thinks of as customer data
 * (ADR-0021 §4). A form submission archive would be exactly that, and a far
 * richer one: names, phone numbers and free-text messages from every enquiry a
 * business has ever received.
 *
 * What the visitor typed becomes the CONTACT, the ACQUISITION and the
 * OPPORTUNITY. Those are governed by erasure. This row records that a
 * submission happened and how it resolved, so an operator can answer "did that
 * enquiry arrive?" without the answer being a second copy of the enquiry.
 */
export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    formId: uuid('form_id')
      .notNull()
      .references((): AnyPgColumn => forms.id, { onDelete: 'cascade' }),
    /**
     * Which configuration this was submitted under. `set null` rather than
     * cascade: losing a version must not delete the record that a lead arrived.
     */
    formVersionId: uuid('form_version_id').references((): AnyPgColumn => formVersions.id, {
      onDelete: 'set null',
    }),

    outcome: submissionOutcomeEnum('outcome').notNull(),

    /**
     * What the ingestion produced. `set null` throughout — a submission
     * receipt outlives the records it created, including through erasure.
     */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    acquisitionId: uuid('acquisition_id').references(() => acquisitions.id, {
      onDelete: 'set null',
    }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),

    /** True when ingestion attached to an existing person rather than creating one. */
    matchedExisting: boolean('matched_existing').notNull().default(false),

    /**
     * The classified source, denormalised from the acquisition so the
     * submissions list renders without a join and still reads correctly after
     * an erasure has cleared the acquisition's linkable detail.
     */
    sourceType: text('source_type'),

    /**
     * Why a rejected submission was rejected — for the OPERATOR, never for the
     * submitter. A public response says only "not accepted"; telling a bot
     * which signal caught it is telling it what to change.
     */
    rejectionReason: text('rejection_reason'),

    /**
     * Diagnostic only. Byte size and duration, never content.
     * `{ bytes: 412, durationMs: 38, challenge: 'skipped' }`
     */
    diagnostics: jsonb('diagnostics').$type<Record<string, string | number | boolean>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('form_submissions_form_created_idx').on(table.formId, table.createdAt),
    index('form_submissions_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('form_submissions_contact_idx').on(table.contactId),
  ],
);

// ---------------------------------------------------------------------------
// public_submission_limits
// ---------------------------------------------------------------------------

/**
 * The durable half of the two-tier public rate limiter (ADR-0030 §3).
 *
 * NOT workspace-scoped and NOT RLS-protected, deliberately: it is consulted
 * before the tenant is known is false — the form resolves first — but it is
 * keyed by a HASH of the subject (IP, or IP+form), and holds no tenant data
 * and no PII. Rows are counters.
 *
 * ⚠️ The IP is NEVER stored. `subject_hash` is
 * `SHA-256(scope || ':' || value)`, so an operator with database access cannot
 * read the IP addresses of a customer's website visitors out of it.
 */
export const publicSubmissionLimits = pgTable(
  'public_submission_limits',
  {
    /** `SHA-256(scope:value)`. One row per subject per window. */
    subjectHash: text('subject_hash').primaryKey(),
    /** Start of the fixed window this counter belongs to. */
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [
    // Sweeping expired windows. The worker prunes; nothing depends on it
    // having run, because the window start is checked on read.
    index('public_submission_limits_window_idx').on(table.windowStartedAt),
  ],
);

export type FormRow = typeof forms.$inferSelect;
export type FormVersionRow = typeof formVersions.$inferSelect;
export type FormSubmissionRow = typeof formSubmissions.$inferSelect;
