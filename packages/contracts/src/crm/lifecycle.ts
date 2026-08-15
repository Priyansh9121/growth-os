/**
 * CRM data lifecycle contracts — merge, erasure, ingestion, tags, custom
 * fields and CSV import.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The public shape of every Stage 2.5 operation. As with `schemas.ts`, these
 * are explicit projections rather than database rows, and they live in
 * `contracts` so a client component can validate a form without pulling the
 * PostgreSQL driver into the browser bundle.
 *
 * A NOTE ON THE DESTRUCTIVE OPERATIONS
 * `mergeContacts` and `eraseContact` both take an explicit confirmation and
 * both have a preview counterpart that mutates nothing. That asymmetry is
 * deliberate: an operation with no undo needs a way to see its blast radius
 * before it happens, and the preview is the only honest substitute for one.
 *
 * @see docs/decisions/ADR-0019-contact-merge.md
 * @see docs/decisions/ADR-0020-privacy-erasure.md
 * @see docs/decisions/ADR-0021-ingestion-and-idempotency.md
 * @see docs/decisions/ADR-0022-custom-field-storage.md
 * @see docs/decisions/ADR-0023-csv-import.md
 */

import { z } from 'zod';
import {
  CUSTOM_FIELD_TYPES,
  IMPORT_BATCH_STATUSES,
  IMPORT_FIELD_TARGETS,
  INGESTION_MATCH_POLICIES,
  TAG_TONES,
  type CustomFieldType,
  type ImportBatchStatus,
  type ImportFieldTarget,
  type IngestionMatchResult,
  type IngestionOutcome,
  type SourceType,
  type TagTone,
} from './enums';
import { provenanceSchema } from './provenance';

const uuid = z.uuid();

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * The fields a merge may need a human decision on.
 *
 * A CLOSED SET, not "any column". Merge resolves identity, not arbitrary
 * state: allowing an override of `workspaceId`, `createdAt` or
 * `mergedIntoContactId` would turn a conflict-resolution form into a
 * general-purpose row editor with none of the checks the update path has.
 */
export const MERGEABLE_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'companyId',
  'ownerUserId',
] as const;
export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

export const MERGEABLE_FIELD_LABELS: Readonly<Record<MergeableField, string>> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  companyId: 'Company',
  ownerUserId: 'Owner',
};

export const mergeContactsSchema = z.object({
  /** The contact that remains. Its id is the one that keeps working. */
  survivorId: uuid,
  /** The contact that becomes a redirect tombstone. */
  duplicateId: uuid,

  /**
   * Per-field choices for genuine conflicts, `field -> 'survivor' | 'duplicate'`.
   *
   * Only consulted where BOTH contacts hold a different non-null value. Where
   * the survivor is NULL the duplicate's value fills the gap regardless — that
   * is a strict gain with no information loss and needs no decision.
   */
  // `partialRecord`, not `record`: with an enum key, Zod 4's `record` requires
  // EVERY key to be present, which would force a caller to state a choice for
  // all six fields even when only one conflicts.
  fieldChoices: z
    .partialRecord(z.enum(MERGEABLE_FIELDS), z.enum(['survivor', 'duplicate']))
    .optional(),

  /**
   * Must be `true`. Not decoration: it means a merge cannot be triggered by a
   * request that merely names two ids — a CSRF-shaped or mistaken call has to
   * assert intent explicitly, and there is no undo to fall back on.
   */
  confirm: z.literal(true),
});

export type MergeContactsInput = z.infer<typeof mergeContactsSchema>;

/** What a merge would touch. Computed with no mutation whatsoever. */
export interface MergePreview {
  readonly survivor: MergePartyView;
  readonly duplicate: MergePartyView;
  /** Rows that would move from the duplicate onto the survivor. */
  readonly moves: {
    readonly acquisitions: number;
    readonly opportunities: number;
    readonly tasks: number;
    readonly activities: number;
    readonly tags: number;
    readonly customFields: number;
  };
  /**
   * Fields where both hold a different non-null value, so a human must choose.
   * Empty when the merge is unambiguous.
   */
  readonly conflicts: readonly MergeFieldConflict[];
  /** Fields where the survivor is empty and the duplicate is not. Free gains. */
  readonly fills: readonly MergeFieldFill[];
  /** Reasons the merge cannot proceed at all. Empty means it can.  */
  readonly blockers: readonly string[];
}

export interface MergePartyView {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly createdAt: string;
}

export interface MergeFieldConflict {
  readonly field: MergeableField;
  readonly label: string;
  readonly survivorValue: string;
  readonly duplicateValue: string;
}

export interface MergeFieldFill {
  readonly field: MergeableField;
  readonly label: string;
  readonly value: string;
}

export interface MergeResult {
  readonly survivorId: string;
  readonly mergedContactId: string;
  readonly moved: MergePreview['moves'];
}

/**
 * Returned instead of a 404 when a merged contact's id is requested.
 *
 * The id was valid and the record still exists; telling the caller where it
 * went is strictly more useful than a 404 and leaks nothing, since the caller
 * already held the id (ADR-0019 §2).
 */
export interface MergedContactRedirect {
  readonly mergedInto: string;
  readonly mergedAt: string;
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/**
 * The phrase an operator must type to confirm an erasure.
 *
 * NOT a security control — anyone who can reach the endpoint can type it. It
 * is a speed bump whose only job is to make the operator read the sentence
 * above it before doing something with no undo.
 */
export const ERASURE_CONFIRMATION_PHRASE = 'ERASE';

export const eraseContactSchema = z.object({
  contactId: uuid,
  confirmation: z.literal(ERASURE_CONFIRMATION_PHRASE, {
    error: `Type ${ERASURE_CONFIRMATION_PHRASE} to confirm.`,
  }),
});

export type EraseContactInput = z.infer<typeof eraseContactSchema>;

/** What erasure would remove, and — just as importantly — what it would not. */
export interface ErasurePreview {
  readonly contactId: string;
  readonly displayName: string;
  /** Rows whose free text or linkable detail would be cleared. */
  readonly clears: {
    readonly acquisitions: number;
    readonly opportunities: number;
    readonly tasks: number;
    readonly activities: number;
    readonly customFields: number;
    readonly tags: number;
  };
  /**
   * Stated in the UI so nobody believes erasure destroys the commercial
   * record. Deal values, stages and channel attribution survive.
   */
  readonly retained: readonly string[];
  readonly blockers: readonly string[];
}

export interface ErasureResult {
  readonly contactId: string;
  readonly erasedAt: string;
  readonly cleared: ErasurePreview['clears'];
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * The canonical automated-write contract.
 *
 * Channel-neutral by design: it knows nothing about forms, calls or webhooks.
 * Every automated path funnels through it so that dedup behaviour and
 * provenance confidence cannot diverge per integration (ADR-0021).
 */
export const ingestAcquisitionSchema = z.object({
  identity: z
    .object({
      firstName: z.string().trim().min(1).max(120),
      lastName: z.string().trim().max(120).optional(),
      email: z.string().trim().toLowerCase().max(254).email().optional(),
      phone: z.string().trim().min(4).max(32).optional(),
      companyName: z.string().trim().max(200).optional(),
    })
    .refine((value) => value.email !== undefined || value.phone !== undefined, {
      message: 'An ingested lead needs at least an email address or a phone number.',
      path: ['email'],
    }),

  provenance: provenanceSchema,

  /**
   * Optional but strongly encouraged. Without it a retry creates a second
   * acquisition, which inflates the metric this product is sold on.
   *
   * `sourceSystem` scopes the key because third-party ids are not globally
   * unique — two providers can both emit `submission_1`.
   */
  idempotency: z
    .object({
      sourceSystem: z.string().trim().min(1).max(64),
      externalKey: z.string().trim().min(1).max(255),
    })
    .optional(),

  matchPolicy: z.enum(INGESTION_MATCH_POLICIES).default('match_then_create'),

  /** Optionally open a deal in the same transaction as the lead. */
  opportunity: z
    .object({
      title: z.string().trim().min(1).max(200),
      estimatedValueMinor: z.number().int().min(0).max(1_000_000_000).optional(),
      pipelineId: uuid.optional(),
    })
    .optional(),

  /**
   * The seam for Stage 3's abuse controls.
   *
   * Spam scoring, bot detection and origin verification happen in the ADAPTER
   * and arrive here as a decision already made. Keeping them out of the CRM
   * means anti-abuse can be replaced without touching domain logic — and means
   * the CRM never has to hold a heuristic it cannot explain.
   */
  trust: z
    .object({
      origin: z.string().trim().max(255).optional(),
      submittedAt: z.iso.datetime().optional(),
      assessment: z.enum(['trusted', 'unverified', 'suspected_spam']).optional(),
    })
    .optional(),
});

export type IngestAcquisitionInput = z.input<typeof ingestAcquisitionSchema>;
export type IngestAcquisitionParsed = z.infer<typeof ingestAcquisitionSchema>;

export interface IngestionResult {
  readonly outcome: IngestionOutcome;
  readonly match: IngestionMatchResult;
  readonly contactId: string;
  readonly acquisitionId: string;
  readonly opportunityId: string | null;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(60),
  tone: z.enum(TAG_TONES).default('neutral'),
});

export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    tone: z.enum(TAG_TONES).optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied.');

export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export interface TagView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly tone: TagTone;
  readonly contactCount: number;
  readonly archivedAt: string | null;
}

/** A tag as it appears on a contact — no counts, nothing to join for. */
export interface ContactTagView {
  readonly id: string;
  readonly name: string;
  readonly tone: TagTone;
}

export const applyTagSchema = z.object({ tagId: uuid });

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

/**
 * A field key is machine-stable and never changes. The LABEL is what a
 * workspace renames — separating them is what stops a rename from orphaning
 * every stored value.
 */
const customFieldKey = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores.');

export const createCustomFieldSchema = z
  .object({
    key: customFieldKey,
    label: z.string().trim().min(1).max(80),
    type: z.enum(CUSTOM_FIELD_TYPES),
    required: z.boolean().default(false),
    /** Required for `single_select`, forbidden for every other type. */
    options: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
  })
  .refine((value) => (value.type === 'single_select' ? value.options !== undefined : true), {
    message: 'A choice field needs at least one option.',
    path: ['options'],
  })
  .refine((value) => (value.type === 'single_select' ? true : value.options === undefined), {
    message: 'Only a choice field can have options.',
    path: ['options'],
  })
  .refine(
    (value) => value.options === undefined || new Set(value.options).size === value.options.length,
    { message: 'Options must be distinct.', path: ['options'] },
  );

export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

export const updateCustomFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    required: z.boolean().optional(),
    position: z.number().int().min(0).max(999).optional(),
    archived: z.boolean().optional(),
    /**
     * Options may be ADDED but the type may never change. Changing a field's
     * type would reinterpret every stored value — a `text` value of "yes"
     * becoming a boolean, a "12/03" becoming an ambiguous date. Archive the
     * field and create a new one instead.
     */
    options: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied.');

export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

export interface CustomFieldDefinitionView {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly required: boolean;
  readonly options: readonly string[] | null;
  readonly position: number;
  readonly archivedAt: string | null;
}

/**
 * A custom field value at the API boundary.
 *
 * One `value` union rather than four nullable columns: the storage shape
 * exists so PostgreSQL can compare dates and numbers correctly, and that is
 * not the client's problem.
 */
export const setCustomFieldValueSchema = z.object({
  definitionId: uuid,
  /** `null` clears the value, which deletes the row rather than blanking it. */
  value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
});

export type SetCustomFieldValueInput = z.infer<typeof setCustomFieldValueSchema>;

export interface CustomFieldValueView {
  readonly definitionId: string;
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly value: string | number | boolean | null;
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

/**
 * Import limits, enforced BEFORE parsing rather than after.
 *
 * A cap checked after parsing has already spent the memory it was meant to
 * bound, which makes it decoration rather than a limit.
 */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;
/** Rows per transaction. One transaction over 10,000 rows holds locks far too long. */
export const IMPORT_CHUNK_SIZE = 200;

export const importMappingSchema = z.object({
  /**
   * CSV header -> target field. The target is a value from a CLOSED allowlist,
   * never a column name — otherwise a crafted mapping could aim a column at
   * `workspace_id` (ADR-0023 §5).
   */
  mapping: z.record(z.string().min(1).max(255), z.enum(IMPORT_FIELD_TARGETS)),
  filename: z.string().trim().min(1).max(255),
  /** The parsed rows, already bounded by IMPORT_MAX_ROWS at the parse step. */
  rows: z.array(z.record(z.string(), z.string())).max(IMPORT_MAX_ROWS),
});

export type ImportMappingInput = z.infer<typeof importMappingSchema>;

/** One row that failed validation, reported by number so it can be found. */
export interface ImportRowIssue {
  /** 1-based, matching what a spreadsheet shows, excluding the header. */
  readonly row: number;
  readonly message: string;
}

export interface ImportValidation {
  readonly totalRows: number;
  readonly validRows: number;
  readonly issues: readonly ImportRowIssue[];
  /**
   * Rows whose email or phone already matches a live contact. Not an error —
   * ingestion will attach the acquisition to the existing person rather than
   * create a duplicate — but the operator should see it before committing.
   */
  readonly matchesExisting: number;
}

export interface ImportResult {
  readonly batchId: string;
  readonly status: ImportBatchStatus;
  readonly totalRows: number;
  readonly importedRows: number;
  readonly matchedExistingRows: number;
  readonly failedRows: number;
  readonly issues: readonly ImportRowIssue[];
}

export interface ImportBatchView {
  readonly id: string;
  readonly filename: string;
  readonly status: ImportBatchStatus;
  readonly totalRows: number;
  readonly importedRows: number;
  readonly matchedExistingRows: number;
  readonly failedRows: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** Re-exported so the UI can render a status without importing enums directly. */
export const IMPORT_STATUS_LABELS: Readonly<Record<ImportBatchStatus, string>> = {
  validating: 'Checking',
  ready: 'Ready to import',
  importing: 'Importing',
  completed: 'Completed',
  partial: 'Partly imported',
  failed: 'Failed',
};

void IMPORT_BATCH_STATUSES;

/**
 * Guard against CSV formula injection on EXPORT.
 *
 * A cell beginning `=`, `+`, `-`, `@`, TAB or CR is executed as a formula by
 * Excel, Google Sheets and LibreOffice when the file is opened. `=cmd|'/c
 * calc'!A1` is a spreadsheet exploit, not a name.
 *
 * Prefixing with an apostrophe is the standard mitigation: the spreadsheet
 * treats the cell as literal text and the apostrophe itself is not displayed.
 *
 * Lives here rather than in the export route so import and export cannot
 * disagree about what is dangerous.
 */
export function neutraliseCsvFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Source type used for every imported acquisition. Never taken from the file. */
export const IMPORT_SOURCE_TYPE: SourceType = 'import';

/** Fields that must be present after mapping for a row to be importable. */
export const IMPORT_REQUIRED_TARGETS: readonly ImportFieldTarget[] = ['firstName'];
