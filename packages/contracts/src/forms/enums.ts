/**
 * Lead capture enumerations.
 *
 * Same discipline as the CRM enums: the single definition of every closed set,
 * with the database deriving its native enums from these constants so the two
 * cannot drift.
 *
 * @see docs/decisions/ADR-0026-public-form-resolution.md
 */

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const SITE_STATUSES = ['active', 'inactive'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

/**
 * Whether we have evidence the workspace controls this origin.
 *
 * Stage 3 requires only `unverified` — embedding a form on a site you do not
 * own harms only you, since the submissions land in your own CRM. Stage 4's
 * crawler and Stage 6's Search Console are claims about ownership and will
 * require `verified` (ADR-0029 §3).
 */
export const SITE_VERIFICATION_STATES = ['unverified', 'pending', 'verified'] as const;
export type SiteVerificationState = (typeof SITE_VERIFICATION_STATES)[number];

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/**
 * Form lifecycle.
 *
 * Only `active` accepts public submissions. `draft` is the default, so a form
 * that has never been deliberately published is closed by construction rather
 * than by a check somebody remembered to write.
 */
export const FORM_STATUSES = ['draft', 'active', 'inactive'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FORM_STATUS_LABELS: Readonly<Record<FormStatus, string>> = {
  draft: 'Draft',
  active: 'Live',
  inactive: 'Paused',
};

/**
 * Field types available in V1.
 *
 * Deliberately small. Excluded on purpose: file upload (storage, virus
 * scanning, a whole retention question), payment (PCI), signature (legal
 * weight we cannot back), and conditional sections (a rules engine). Each is a
 * project, not a list entry.
 */
export const FORM_FIELD_TYPES = [
  'text',
  'email',
  'phone',
  'textarea',
  'select',
  'checkbox',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const FORM_FIELD_TYPE_LABELS: Readonly<Record<FormFieldType, string>> = {
  text: 'Text',
  email: 'Email',
  phone: 'Phone',
  textarea: 'Long text',
  select: 'Dropdown',
  checkbox: 'Checkbox',
};

/**
 * Where a field's value goes in the CRM.
 *
 * A CLOSED SET, never a column name. The same rule as CSV import (ADR-0023
 * §5): if mapping targeted columns directly, a crafted form configuration
 * could aim a public input at `workspace_id`.
 *
 * `note` becomes the acquisition's `channelDetail` — a human note about the
 * enquiry. It is NEVER promoted to a provenance field.
 *
 * `custom:<key>` targets a contact custom field and is validated separately,
 * because the valid set is per-workspace.
 */
export const FORM_FIELD_TARGETS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'companyName',
  'note',
  'none',
] as const;
export type FormFieldTarget = (typeof FORM_FIELD_TARGETS)[number];

export const FORM_FIELD_TARGET_LABELS: Readonly<Record<FormFieldTarget, string>> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  companyName: 'Company',
  note: 'Enquiry note',
  none: 'Do not store',
};

/** Prefix marking a mapping onto a workspace-defined contact custom field. */
export const CUSTOM_FIELD_TARGET_PREFIX = 'custom:';

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/**
 * How a public submission resolved.
 *
 * `duplicate` is a SUCCESS: the idempotency key was seen before and the
 * original result is returned unchanged. `rejected` covers every abuse and
 * validation refusal — the operator sees which, the submitter never does.
 */
export const SUBMISSION_OUTCOMES = ['created', 'duplicate', 'rejected'] as const;
export type SubmissionOutcome = (typeof SUBMISSION_OUTCOMES)[number];

export const SUBMISSION_OUTCOME_LABELS: Readonly<Record<SubmissionOutcome, string>> = {
  created: 'Lead captured',
  duplicate: 'Retry (already captured)',
  rejected: 'Rejected',
};

/**
 * Why a submission was refused. **Operator-facing only.**
 *
 * The public response is identical for every one of these. Telling a bot which
 * signal caught it is telling it precisely what to change.
 */
export const REJECTION_REASONS = [
  'form_not_accepting',
  'validation_failed',
  'rate_limited',
  'honeypot',
  'too_fast',
  'origin_not_allowed',
  'payload_too_large',
  'challenge_failed',
  'identity_missing',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const REJECTION_REASON_LABELS: Readonly<Record<RejectionReason, string>> = {
  form_not_accepting: 'Form was not accepting submissions',
  validation_failed: 'Failed validation',
  rate_limited: 'Rate limited',
  honeypot: 'Hidden field was filled',
  too_fast: 'Submitted implausibly fast',
  origin_not_allowed: 'Origin not allowed',
  payload_too_large: 'Payload too large',
  challenge_failed: 'Challenge not passed',
  identity_missing: 'No email or phone supplied',
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ---------------------------------------------------------------------------
// Theming
// ---------------------------------------------------------------------------

/**
 * Theme options for the public form.
 *
 * A closed set plus one validated accent colour. Arbitrary CSS is never
 * accepted: a customer-supplied stylesheet loaded into our origin is a
 * self-XSS vector and an unbounded support surface (ADR-0027).
 */
export const FORM_THEMES = ['light', 'dark', 'auto'] as const;
export type FormTheme = (typeof FORM_THEMES)[number];
