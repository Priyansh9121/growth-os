/**
 * CRM data lifecycle — how records entered, and how identity left.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Three tables that describe the *movement* of customer data rather than the
 * data itself:
 *
 *   ingestion_receipts  every automated write, keyed for safe retry (ADR-0021)
 *   import_batches      one CSV upload and how it resolved       (ADR-0023)
 *   erasure_requests    a permanent, PII-free log of erasures    (ADR-0020)
 *
 * ⚠️ NONE OF THESE TABLES STORES PII. That is a hard rule, not a preference:
 * a receipt holding a raw webhook payload, or a batch holding parsed CSV rows,
 * would be a second copy of customer data in a table nobody thinks of as
 * customer data — outside erasure's reach and invisible to retention policy.
 * Receipts store a digest; batches store counts and column names.
 *
 * @see docs/decisions/ADR-0020-privacy-erasure.md
 * @see docs/decisions/ADR-0021-ingestion-and-idempotency.md
 * @see docs/decisions/ADR-0023-csv-import.md
 */

import {
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
import { IMPORT_BATCH_STATUSES } from '@growth-os/contracts';
import { users } from './identity';
import { workspaces } from './tenancy';
import { acquisitions, contacts, opportunities } from './crm';

export const importBatchStatusEnum = pgEnum('crm_import_batch_status', IMPORT_BATCH_STATUSES);

// ---------------------------------------------------------------------------
// ingestion_receipts
// ---------------------------------------------------------------------------

/**
 * Idempotency receipts for automated ingestion (ADR-0021).
 *
 * THE PROBLEM THIS SOLVES
 * Every automated caller retries. Webhook providers retry on timeout, browsers
 * retry on flaky connections, import runs get re-run. Without a receipt, a
 * retried submission creates a second acquisition and inflates the exact
 * metric this product is sold on.
 *
 * WHY THE KEY IS SCOPED BY SOURCE SYSTEM
 * Third-party ids are NOT globally unique. Two form providers can both emit
 * `submission_1`; a Facebook lead id and a Google lead id can collide. A global
 * key would silently drop a real lead as a "duplicate" of an unrelated one.
 */
export const ingestionReceipts = pgTable(
  'ingestion_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** `website_form`, `facebook_leads`, `voice`, `import` — who is calling. */
    sourceSystem: text('source_system').notNull(),
    /** The caller's own stable id for this submission. */
    externalKey: text('external_key').notNull(),

    /**
     * SHA-256 over the NORMALISED identity and provenance — deliberately not
     * over the raw payload, so a provider adding a field or reordering JSON
     * does not turn a legitimate retry into a conflict.
     *
     * A digest, never the payload: see the file header.
     */
    requestDigest: text('request_digest').notNull(),

    /**
     * What the original request produced. `set null` rather than cascade: the
     * receipt must survive so a later retry still resolves to "already done"
     * instead of silently creating a second lead.
     */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    acquisitionId: uuid('acquisition_id').references(() => acquisitions.id, {
      onDelete: 'set null',
    }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * THE IDEMPOTENCY CONSTRAINT. Enforced by the database, not by a
     * read-then-write in application code — which races under concurrent
     * retries, exactly the situation this exists for.
     */
    uniqueIndex('ingestion_receipts_workspace_source_key_unique').on(
      table.workspaceId,
      table.sourceSystem,
      table.externalKey,
    ),
    index('ingestion_receipts_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// import_batches
// ---------------------------------------------------------------------------

/**
 * One CSV import (ADR-0023).
 *
 * Holds counts and the column mapping — never parsed rows. The uploaded file
 * itself is parsed in memory and never written to disk, so there is no upload
 * directory to leak, scan, or forget to clean up.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /**
     * The operator's own filename, so a batch is identifiable in the results
     * list. Stored, never logged: a filename can carry a customer's name.
     */
    filename: text('filename').notNull(),

    status: importBatchStatusEnum('status').notNull().default('validating'),

    /**
     * Outcome counters. `imported + failed + skippedDuplicate` need not equal
     * `validRows` while a run is in flight; they do once it settles.
     */
    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    invalidRows: integer('invalid_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    matchedExistingRows: integer('matched_existing_rows').notNull().default(0),

    /**
     * `{ "Email Address": "email" }` — CSV header to a value from the closed
     * `IMPORT_FIELD_TARGETS` allowlist.
     *
     * Header names are metadata a person chose for their own spreadsheet, not
     * customer data. Row VALUES never appear here.
     */
    columnMapping: jsonb('column_mapping').$type<Record<string, string>>(),

    startedByUserId: uuid('started_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('import_batches_workspace_started_idx').on(table.workspaceId, table.startedAt)],
);

// ---------------------------------------------------------------------------
// erasure_requests
// ---------------------------------------------------------------------------

/**
 * A permanent record that an erasure happened (ADR-0020 §6).
 *
 * WHY THIS OUTLIVES THE OPERATION
 * Erasure clears the LIVE database. It does not reach into backups. Restoring
 * a backup therefore resurrects data that a person asked to have removed —
 * unless the erasures are replayed before the restored data returns to service.
 * That replay needs a list, and this is it.
 *
 * WHY `contact_id` HAS NO FOREIGN KEY
 * Deliberate. The list must remain replayable against a restored database
 * whose contact rows are a different generation. A foreign key would tie this
 * log's validity to the very table it exists to correct.
 *
 * CONTAINS NO PII, BY CONSTRUCTION. An erasure log that preserved the erased
 * name would defeat the erasure. Ids, counts and timestamps only.
 */
export const erasureRequests = pgTable(
  'erasure_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Opaque identifier. No FK — see above. */
    contactId: uuid('contact_id').notNull(),

    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    /**
     * How many rows in each table were anonymised. Counts only — never the
     * values that were removed.
     */
    affectedCounts: jsonb('affected_counts').$type<Record<string, number>>().notNull(),

    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('erasure_requests_workspace_completed_idx').on(table.workspaceId, table.completedAt),
    index('erasure_requests_contact_idx').on(table.contactId),
  ],
);

export type IngestionReceiptRow = typeof ingestionReceipts.$inferSelect;
export type ImportBatchRow = typeof importBatches.$inferSelect;
export type ErasureRequestRow = typeof erasureRequests.$inferSelect;
