/**
 * Lead capture contracts.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The shapes crossing three different trust boundaries, which is why they are
 * separated rather than reused:
 *
 *   ADMIN     an authenticated operator configuring a form
 *   PUBLIC    an anonymous browser submitting one
 *   RENDER    what a public browser is allowed to KNOW about a form
 *
 * The third is the one it would be easy to get wrong. A public renderer needs
 * the field list and the labels; it must never receive the CRM mapping, the
 * opportunity rule, the pipeline id, or anything else about the workspace. So
 * `PublicFormView` is a deliberately narrow projection, not the admin view with
 * a couple of keys removed.
 *
 * @see docs/decisions/ADR-0026-public-form-resolution.md
 */

import { z } from 'zod';
import { CUSTOM_FIELD_KEY_MAX_LENGTH } from '../crm/enums';
import {
  CUSTOM_FIELD_TARGET_PREFIX,
  FORM_FIELD_TARGETS,
  FORM_FIELD_TYPES,
  FORM_STATUSES,
  FORM_THEMES,
  type FormFieldType,
  type FormStatus,
  type FormTheme,
  type RejectionReason,
  type SubmissionOutcome,
} from './enums';

const uuid = z.uuid();

/**
 * A field's stable key.
 *
 * Generated once and never changed, because a submission is interpreted
 * through it. Renaming a LABEL is free; renaming a key would orphan meaning.
 */
const fieldKey = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores.');

/**
 * Longest `custom:<key>` target: the prefix plus the longest key the CRM will
 * accept. Derived from `CUSTOM_FIELD_KEY_MAX_LENGTH` rather than written as a
 * number, so a target can always name any key a workspace has created.
 */
const MAX_FIELD_TARGET_LENGTH = CUSTOM_FIELD_TARGET_PREFIX.length + CUSTOM_FIELD_KEY_MAX_LENGTH;

/**
 * A CRM mapping target: one of the closed set, or `custom:<key>`.
 *
 * Never a column name. Validated as a union so an unknown target fails at the
 * boundary rather than being silently ignored during submission.
 *
 * ⚠️ THE QUANTIFIER IS BOUNDED, AND `.max()` ALONE WOULD NOT BE ENOUGH.
 * Measured on zod 4.4.3 (dev log 0027): zod v4 runs every check and collects
 * all issues, so `.max()` bounds what is ACCEPTED and never what is EXAMINED —
 * a `.regex()` beside it still runs against the full input. With `*` the
 * pattern cost was linear in the input: 2.33 ms against 4 MB. With `{0,47}` it
 * is anchored and finitely bounded, so the engine tries one start offset,
 * consumes at most 55 characters and gives up — a flat 0.00013 ms from 1 KB to
 * 4 MB, independent of input length rather than merely cheap.
 *
 * `.max()` is kept as well: it states the bound where a reader looks for it and
 * produces `too_big` rather than a pattern-mismatch message.
 *
 * @see docs/decisions/ADR-0046-field-target-bound.md
 */
const fieldTarget = z.union([
  z.enum(FORM_FIELD_TARGETS),
  z
    .string()
    .max(MAX_FIELD_TARGET_LENGTH)
    .regex(
      new RegExp(
        `^${CUSTOM_FIELD_TARGET_PREFIX}[a-z][a-z0-9_]{0,${CUSTOM_FIELD_KEY_MAX_LENGTH - 1}}$`,
      ),
      'A custom field target looks like custom:property_type.',
    ),
]);

// ---------------------------------------------------------------------------
// Form configuration
// ---------------------------------------------------------------------------

export const formFieldConfigSchema = z.object({
  key: fieldKey,
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string().trim().min(1).max(120),
  placeholder: z.string().trim().max(120).optional(),
  helpText: z.string().trim().max(200).optional(),
  required: z.boolean().default(false),
  /** `select` choices. Required for `select`, forbidden otherwise. */
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
  target: fieldTarget.default('none'),
  /** Per-field length cap, bounded well below the request cap. */
  maxLength: z.number().int().min(1).max(2000).default(500),
});

export type FormFieldConfig = z.infer<typeof formFieldConfigSchema>;

/**
 * Where a visitor goes after a successful submission.
 *
 * A redirect URL is configured by an AUTHENTICATED ADMIN and validated here.
 * `javascript:`, `data:` and every other non-HTTPS scheme are refused: a form
 * that can redirect to `javascript:` is an XSS primitive published on a
 * customer's website.
 */
export const successBehaviourSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    message: z.string().trim().min(1).max(500),
  }),
  z.object({
    kind: z.literal('redirect'),
    url: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        // Parsed rather than pattern-matched. `javascript:alert(1)` and
        // `java\tscript:alert(1)` differ as strings and not as URLs.
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      }, 'Enter an https:// address.'),
  }),
]);

export type SuccessBehaviour = z.infer<typeof successBehaviourSchema>;

/**
 * Whether a submission opens a deal, and where.
 *
 * The title uses a TINY CONTROLLED VOCABULARY — `{contact}`, `{form}`,
 * `{company}` — expanded by string replacement. There is no expression
 * language and no code execution: a template that could evaluate would be
 * remote code execution configured through a web form.
 */
export const opportunityRuleSchema = z.object({
  enabled: z.boolean().default(false),
  pipelineId: uuid.optional(),
  titleTemplate: z.string().trim().min(1).max(120).default('{contact} — {form}'),
  estimatedValueMinor: z.number().int().min(0).max(1_000_000_000).optional(),
});

export type OpportunityRule = z.infer<typeof opportunityRuleSchema>;

export const formSettingsConfigSchema = z.object({
  submitLabel: z.string().trim().min(1).max(60).default('Send enquiry'),
  success: successBehaviourSchema.default({
    kind: 'message',
    message: 'Thanks — we have your enquiry and will be in touch shortly.',
  }),
  opportunity: opportunityRuleSchema.default({
    enabled: false,
    titleTemplate: '{contact} — {form}',
  }),
  theme: z.enum(FORM_THEMES).default('auto'),
  /** Validated hex. Never arbitrary CSS. */
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2563eb.')
    .optional(),
  /**
   * Origins permitted to embed this form.
   *
   * ⚠️ ABUSE REDUCTION, NOT TENANCY. `Origin` is a browser-supplied header and
   * is trivially forged by anything that is not a browser. Empty means any
   * origin, which is the correct default for a form whose whole purpose is to
   * be embedded on a site we may not know about yet (ADR-0026 §5).
   */
  allowedOrigins: z.array(z.string().trim().max(255)).max(20).default([]),
  /** A hidden field bots fill in. ONE signal, never the only one. */
  honeypotEnabled: z.boolean().default(true),
  /**
   * Minimum plausible time from render to submit.
   *
   * Deliberately low. A keyboard-fluent person using autofill submits a short
   * form in a few seconds, and blocking them to catch a bot is trading a real
   * lead for a spam one.
   */
  minSubmitSeconds: z.number().int().min(0).max(60).default(2),
});

export type FormSettingsConfig = z.infer<typeof formSettingsConfigSchema>;

/**
 * A complete version snapshot.
 *
 * Parsed on write AND on read. A row written by an older build must still
 * parse, or the public form fails closed rather than rendering something it
 * does not understand.
 */
export const formVersionConfigSchema = z.object({
  fields: z.array(formFieldConfigSchema).min(1).max(30),
  settings: formSettingsConfigSchema,
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

export const createFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  siteId: uuid.optional(),
});

export type CreateFormInput = z.infer<typeof createFormSchema>;

export const updateFormSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    siteId: uuid.nullable().optional(),
    /**
     * Editing configuration always creates a NEW VERSION rather than mutating
     * one, so a lead captured under version 3 keeps meaning what it meant.
     */
    config: formVersionConfigSchema.optional(),
    status: z.enum(FORM_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied.');

export type UpdateFormInput = z.infer<typeof updateFormSchema>;

export interface FormSummaryView {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly status: FormStatus;
  readonly version: number | null;
  readonly siteId: string | null;
  readonly siteOrigin: string | null;
  readonly submissionCount: number;
  readonly leadCount: number;
  readonly lastSubmissionAt: string | null;
  readonly createdAt: string;
}

export interface FormDetailView extends FormSummaryView {
  readonly config: z.infer<typeof formVersionConfigSchema> | null;
  /** Every published version, newest first. Configuration history. */
  readonly versions: readonly { id: string; version: number; createdAt: string }[];
}

// ---------------------------------------------------------------------------
// Public rendering
// ---------------------------------------------------------------------------

/**
 * ⚠️ EVERYTHING AN ANONYMOUS BROWSER MAY KNOW ABOUT A FORM.
 *
 * A narrow projection, not the admin view minus a few keys — so that adding a
 * field to the admin view cannot silently publish it. Notably absent: the CRM
 * mapping (`target`), the opportunity rule, the pipeline, the workspace, the
 * form's internal id, allowed origins and the abuse settings.
 *
 * `target` is absent because it tells a caller which input becomes the email
 * address and which becomes a note — useful to nobody rendering a form, and
 * useful to somebody probing one.
 */
export interface PublicFormFieldView {
  readonly key: string;
  readonly type: FormFieldType;
  readonly label: string;
  readonly placeholder: string | null;
  readonly helpText: string | null;
  readonly required: boolean;
  readonly options: readonly string[] | null;
  readonly maxLength: number;
}

export interface PublicFormView {
  /** The public key. The caller already has it; echoing it is harmless. */
  readonly publicKey: string;
  readonly name: string;
  readonly fields: readonly PublicFormFieldView[];
  readonly submitLabel: string;
  readonly theme: FormTheme;
  readonly accent: string | null;
  readonly honeypotEnabled: boolean;
  /** The honeypot's field name, randomised per version so it is not a constant. */
  readonly honeypotKey: string | null;
}

// ---------------------------------------------------------------------------
// Public submission
// ---------------------------------------------------------------------------

/**
 * Attribution context, captured by the tracking script.
 *
 * ⚠️ EVERY FIELD HERE IS UNTRUSTED. It arrives from a browser and can be
 * anything. What makes it usable is that the SERVER decides what it means:
 * these are raw signals, and `classifySource` turns them into a source type
 * and a confidence. A browser cannot state `sourceType`, `confidence` or
 * `searchQuery` — those are not in this schema at all, which is the point.
 */
export const submissionContextSchema = z.object({
  /** PATH only. The script strips the query string before storing it. */
  landingPath: z.string().trim().max(512).optional(),
  /** The page the form was on. Distinct from the landing page. */
  submissionPath: z.string().trim().max(512).optional(),
  /** ORIGIN only, never a full referring URL — query strings carry PII. */
  referrerOrigin: z.string().trim().max(255).optional(),
  utmSource: z.string().trim().max(255).optional(),
  utmMedium: z.string().trim().max(255).optional(),
  utmCampaign: z.string().trim().max(255).optional(),
  utmTerm: z.string().trim().max(255).optional(),
  utmContent: z.string().trim().max(255).optional(),
  gclid: z.string().trim().max(255).optional(),
  fbclid: z.string().trim().max(255).optional(),
  /** Opaque per-tab id. Correlation only; never linked to a person. */
  sessionId: z.string().trim().max(64).optional(),
  /** Milliseconds from render to submit. One abuse signal among several. */
  elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
});

export type SubmissionContext = z.infer<typeof submissionContextSchema>;

export const publicSubmissionSchema = z.object({
  /**
   * Answers keyed by field key. Values are validated against the version's
   * field list server-side — this schema only bounds the envelope.
   */
  values: z.record(z.string().max(48), z.union([z.string().max(2000), z.boolean()])),

  /**
   * Client-generated submission id, used as the idempotency key.
   *
   * Client-generated deliberately: only the client knows that a retry is the
   * SAME submission rather than a second one. It is scoped server-side to the
   * form, so it cannot collide across tenants (ADR-0021 §3).
   */
  submissionId: z.string().trim().min(8).max(64),

  context: submissionContextSchema.default({}),

  /** The honeypot's value, if the version uses one. Must be empty. */
  trap: z.string().max(200).optional(),

  /** Opaque token from a challenge provider, when one is configured. */
  challengeToken: z.string().max(4096).optional(),
});

export type PublicSubmissionInput = z.infer<typeof publicSubmissionSchema>;

/**
 * ⚠️ EVERYTHING AN ANONYMOUS BROWSER LEARNS FROM A SUBMISSION.
 *
 * No contact id, no acquisition id, no opportunity id, no workspace id. A
 * browser that could read internal identifiers back could enumerate a CRM one
 * submission at a time.
 *
 * `reference` is the caller's OWN submission id echoed back — it tells them
 * their retry was recognised without disclosing anything of ours.
 */
export interface PublicSubmissionResponse {
  readonly ok: true;
  readonly reference: string;
  readonly success: SuccessBehaviour;
}

/**
 * The single public failure shape.
 *
 * Identical for a spam rejection, a rate limit, a disabled form and an unknown
 * key. Telling a bot which signal caught it is telling it what to change; the
 * operator sees the real reason in the submissions list.
 */
export interface PublicSubmissionRejection {
  readonly ok: false;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Submission receipts (operator view)
// ---------------------------------------------------------------------------

export interface SubmissionReceiptView {
  readonly id: string;
  readonly outcome: SubmissionOutcome;
  readonly rejectionReason: RejectionReason | null;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly matchedExisting: boolean;
  readonly opportunityId: string | null;
  readonly sourceType: string | null;
  readonly formVersion: number | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Accepted loosely and normalised to an origin server-side. */
  origin: z.string().trim().min(4).max(255),
});

export type CreateSiteInput = z.infer<typeof createSiteSchema>;

export interface SiteView {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly status: 'active' | 'inactive';
  readonly verificationState: 'unverified' | 'pending' | 'verified';
  readonly formCount: number;
  readonly createdAt: string;
}
