/**
 * CRM input contracts and view types.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The API's public shape. Deliberately NOT the database's shape.
 *
 * WHY DATABASE ROWS ARE NOT API CONTRACTS
 * A Drizzle row type exposes every column, including ones that are internal
 * (`emailNormalised`), sensitive, or simply not the API's business. Exporting
 * it as the contract means every schema change is a breaking API change, and
 * every new column is published by default — the opposite of the intent.
 * These view types are an explicit projection.
 *
 * These live in `contracts` rather than `@growth-os/crm` so that client
 * components can import them for form validation without pulling the database
 * driver into the browser bundle (ADR-0011 §7).
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 */

import { z } from 'zod';
import {
  CURRENCIES,
  OPPORTUNITY_STATUSES,
  SOURCE_TYPES,
  STAGE_CATEGORIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ActivityType,
  type ActorType,
  type Currency,
  type OpportunityStatus,
  type ProvenanceConfidence,
  type SourcePlatform,
  type SourceType,
  type StageCategory,
  type TaskPriority,
  type TaskStatus,
} from './enums';
import { provenanceSchema } from './provenance';

const uuid = z.uuid();

/** Names are bounded but otherwise unconstrained — real names defy validation. */
const personName = z.string().trim().min(1).max(120);
const optionalPersonName = z.string().trim().max(120).optional();

/**
 * Email accepted at the CRM boundary.
 *
 * Normalisation (trim + lowercase) happens here so that every ingestion path
 * agrees. Provider-specific rewriting — stripping dots or `+aliases` — is
 * deliberately NOT applied: those rules are Gmail's, and applying them
 * universally silently merges different people (ADR-0015).
 */
const contactEmail = z.string().trim().toLowerCase().max(254).email().optional();

/**
 * Phone accepted as free text and normalised to E.164 server-side.
 *
 * Validated for length only here: a client cannot reliably know which formats
 * are valid in the workspace's region, and rejecting a valid number because the
 * client guessed wrong is worse than accepting it and normalising properly.
 */
const contactPhone = z.string().trim().min(4).max(32).optional();

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const createContactSchema = z
  .object({
    firstName: personName,
    lastName: optionalPersonName,
    email: contactEmail,
    phone: contactPhone,
    companyId: uuid.optional(),
    ownerUserId: uuid.optional(),
    /**
     * Optional acquisition recorded with the contact. When present, the
     * contact and its first acquisition are created in ONE transaction — a
     * contact whose provenance failed to save is exactly the data loss this
     * model exists to prevent.
     */
    acquisition: provenanceSchema.optional(),
  })
  .refine((value) => value.email !== undefined || value.phone !== undefined, {
    message: 'A contact needs at least an email address or a phone number.',
    path: ['email'],
  });

export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    firstName: personName.optional(),
    lastName: optionalPersonName,
    email: contactEmail,
    phone: contactPhone,
    companyId: uuid.nullable().optional(),
    ownerUserId: uuid.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied.');

export type UpdateContactInput = z.infer<typeof updateContactSchema>;

/**
 * Result of creating a contact.
 *
 * `duplicateOf` is a REPORT, not an action: the contact is created either way.
 * Merging two people automatically is destructive and effectively
 * irreversible, and shared mailboxes (`office@`, `info@`) are common in the
 * target segment — so the overlap is surfaced and the operator decides
 * (ADR-0015).
 */
export interface CreateContactResult {
  readonly contact: ContactView;
  readonly duplicateOf: {
    readonly id: string;
    readonly displayName: string;
    readonly matchedOn: 'email' | 'phone';
  } | null;
}

/** Client-safe projection of a contact. */
export interface ContactView {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  /** E.164 where parseable, else null. Exposed so the UI can offer tel: links. */
  readonly phoneE164: string | null;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** First-touch provenance, derived from the earliest acquisition. */
  readonly firstSource: ContactSourceView | null;
  readonly openOpportunityCount: number;
  readonly lastActivityAt: string | null;
}

export interface ContactSourceView {
  readonly sourceType: SourceType;
  readonly sourcePlatform: SourcePlatform;
  readonly confidence: ProvenanceConfidence;
  readonly landingPath: string | null;
  readonly capturedAt: string;
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Hostname only. Normalised server-side; used as a weak identity signal. */
  website: z.string().trim().max(255).optional(),
  phone: contactPhone,
  ownerUserId: uuid.optional(),
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied.');

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export interface CompanyView {
  readonly id: string;
  readonly name: string;
  readonly website: string | null;
  readonly phone: string | null;
  readonly ownerUserId: string | null;
  readonly contactCount: number;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

// ---------------------------------------------------------------------------
// Acquisitions
// ---------------------------------------------------------------------------

export const recordAcquisitionSchema = z.object({
  contactId: uuid,
  provenance: provenanceSchema,
  /** Server clock is authoritative; a client-supplied time is a hint at most. */
  capturedAt: z.iso.datetime().optional(),
});

export type RecordAcquisitionInput = z.infer<typeof recordAcquisitionSchema>;

export interface AcquisitionView {
  readonly id: string;
  readonly contactId: string;
  readonly sourceType: SourceType;
  readonly sourcePlatform: SourcePlatform;
  readonly confidence: ProvenanceConfidence;
  readonly landingPath: string | null;
  readonly referrerOrigin: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  /** Null unless a source system declared it. Never inferred (ADR-0012). */
  readonly searchQuery: string | null;
  readonly channelDetail: string | null;
  readonly qualifiedAt: string | null;
  readonly capturedAt: string;
}

// ---------------------------------------------------------------------------
// Pipelines and stages
// ---------------------------------------------------------------------------

export const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  stages: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        category: z.enum(STAGE_CATEGORIES),
      }),
    )
    .min(2, 'A pipeline needs at least two stages.')
    .max(20, 'A pipeline may have at most 20 stages.')
    // Reporting depends on terminal stages existing. A pipeline with no way to
    // close is a pipeline that silently accumulates open deals forever.
    .refine(
      (stages) => stages.some((stage) => stage.category === 'won'),
      'A pipeline needs at least one "won" stage.',
    )
    .refine(
      (stages) => stages.some((stage) => stage.category === 'lost'),
      'A pipeline needs at least one "lost" stage.',
    ),
});

export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;

export interface PipelineStageView {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly category: StageCategory;
  readonly openOpportunityCount: number;
  readonly openValueMinor: number;
}

export interface PipelineView {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly currency: Currency;
  readonly stages: readonly PipelineStageView[];
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

/**
 * Monetary amounts are integer MINOR units (cents), never floats.
 *
 * `0.1 + 0.2 !== 0.3` in IEEE-754, and a rounding error in a pipeline value is
 * a customer-visible defect. Capped at ~$10M to catch a caller passing dollars
 * where cents were expected — a mistake that is otherwise silent.
 */
const minorUnits = z.number().int().min(0).max(1_000_000_000);

export const createOpportunitySchema = z.object({
  title: z.string().trim().min(1).max(200),
  contactId: uuid,
  companyId: uuid.optional(),
  pipelineId: uuid,
  /** Defaults to the pipeline's first open stage when omitted. */
  stageId: uuid.optional(),
  ownerUserId: uuid.optional(),
  estimatedValueMinor: minorUnits.optional(),
  currency: z.enum(CURRENCIES).optional(),
  expectedCloseOn: z.iso.date().optional(),
  /** Links the deal to the acquisition that produced it — the attribution join. */
  acquisitionId: uuid.optional(),
});

export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;

export const moveOpportunityStageSchema = z.object({
  stageId: uuid,
  /**
   * Optimistic concurrency guard. Two operators dragging the same card should
   * not silently overwrite one another — the second gets a conflict.
   */
  expectedCurrentStageId: uuid.optional(),
});

export type MoveOpportunityStageInput = z.infer<typeof moveOpportunityStageSchema>;

export const updateOpportunitySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    ownerUserId: uuid.nullable().optional(),
    estimatedValueMinor: minorUnits.optional(),
    expectedCloseOn: z.iso.date().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied.');

export type UpdateOpportunityInput = z.infer<typeof updateOpportunitySchema>;

export interface OpportunityView {
  readonly id: string;
  readonly title: string;
  readonly contactId: string;
  readonly contactName: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly stageCategory: StageCategory;
  readonly status: OpportunityStatus;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  readonly estimatedValueMinor: number;
  readonly currency: Currency;
  readonly expectedCloseOn: string | null;
  readonly sourceType: SourceType | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  dueAt: z.iso.datetime().optional(),
  assignedUserId: uuid.optional(),
  /** Explicit relations rather than polymorphic subject_type/subject_id (ADR-0011 §6). */
  contactId: uuid.optional(),
  opportunityId: uuid.optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueAt: z.iso.datetime().nullable().optional(),
    assignedUserId: uuid.nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied.');

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueAt: string | null;
  readonly assignedUserId: string | null;
  readonly assignedName: string | null;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly opportunityId: string | null;
  readonly opportunityTitle: string | null;
  /** Distinguishes human-created from AI- and automation-created work. */
  readonly createdByType: ActorType;
  readonly createdAt: string;
  readonly completedAt: string | null;
  /** Derived server-side so client clock skew cannot change what looks overdue. */
  readonly isOverdue: boolean;
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export const addNoteSchema = z.object({
  contactId: uuid.optional(),
  opportunityId: uuid.optional(),
  body: z.string().trim().min(1).max(5000),
});

export type AddNoteInput = z.infer<typeof addNoteSchema>;

export interface ActivityView {
  readonly id: string;
  readonly type: ActivityType;
  readonly summary: string;
  readonly detail: string | null;
  readonly actorType: ActorType;
  readonly actorName: string | null;
  readonly contactId: string | null;
  readonly opportunityId: string | null;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// List envelopes
// ---------------------------------------------------------------------------

/**
 * Cursor pagination parameters.
 *
 * Keyset, not offset: offset pagination skips and duplicates rows when data
 * changes between pages — constant in a CRM someone else is editing — and
 * degrades linearly. The cursor is opaque so its encoding stays ours to change
 * (ADR-0016).
 */
export const paginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  /** Capped server-side. A client cannot request an unbounded page. */
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export interface Page<T> {
  readonly items: readonly T[];
  /** Null when there are no further pages. */
  readonly nextCursor: string | null;
}

export const contactFiltersSchema = paginationSchema.extend({
  query: z.string().trim().max(120).optional(),
  ownerUserId: uuid.optional(),
  sourceType: z.enum(SOURCE_TYPES).optional(),
  companyId: uuid.optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'lastName']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type ContactFilters = z.infer<typeof contactFiltersSchema>;

export const opportunityFiltersSchema = paginationSchema.extend({
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
  ownerUserId: uuid.optional(),
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
});

export type OpportunityFilters = z.infer<typeof opportunityFiltersSchema>;

export const taskFiltersSchema = paginationSchema.extend({
  scope: z.enum(['mine', 'all']).default('all'),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  /** Convenience view combining status=open with dueAt in the past. */
  overdueOnly: z.coerce.boolean().optional(),
  dueBefore: z.iso.datetime().optional(),
});

export type TaskFilters = z.infer<typeof taskFiltersSchema>;
