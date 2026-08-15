/**
 * CRM enumerations.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single definition of every closed value set in the CRM. The database
 * derives its native PostgreSQL enums from these constants, so the two cannot
 * drift — adding a value in one place without the other becomes a compile
 * error rather than a runtime surprise.
 *
 * WHICH SETS ARE DATABASE ENUMS AND WHICH ARE TEXT
 * A native PostgreSQL enum gives referential safety but requires a migration
 * for every new value. That is the right trade for small, stable sets
 * (statuses, priorities) and the wrong one for sets that grow with every
 * feature shipped. `ActivityType` is therefore stored as text with a
 * TypeScript union — the same reasoning applied to audit event names in
 * Stage 1.
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 * @see docs/decisions/ADR-0012-provenance-model.md
 */

/**
 * How a person entered Growth OS.
 *
 * `unknown` is a first-class, legitimate value. Most real acquisitions have
 * incomplete provenance, and forcing a guess would fabricate attribution data
 * — see ADR-0012.
 */
export const SOURCE_TYPES = [
  'organic_search',
  'paid_search',
  'google_business_profile',
  'direct',
  'referral',
  'social',
  'email',
  'sms',
  'voice',
  'website_form',
  'website_chat',
  'manual',
  'import',
  'api',
  'unknown',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Readonly<Record<SourceType, string>> = {
  organic_search: 'Organic search',
  paid_search: 'Paid search',
  google_business_profile: 'Google Business Profile',
  direct: 'Direct',
  referral: 'Referral',
  social: 'Social',
  email: 'Email',
  sms: 'SMS',
  voice: 'Phone call',
  website_form: 'Website form',
  website_chat: 'Website chat',
  manual: 'Added manually',
  import: 'Imported',
  api: 'API',
  unknown: 'Unknown',
};

/** The platform the acquisition came through, where identifiable. */
export const SOURCE_PLATFORMS = [
  'google',
  'bing',
  'facebook',
  'instagram',
  'linkedin',
  'growth_os',
  'unknown',
] as const;

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

/**
 * How much the provenance on an acquisition can be trusted.
 *
 * This is the field that separates an attribution report from a guess, and it
 * is required precisely so an ingestion path cannot quietly omit it.
 *
 *  - `declared`  the source system told us authoritatively (Search Console,
 *                an Ads platform, our own form handler)
 *  - `derived`   computed from browser signals (referrer, UTM). User-editable
 *                and frequently absent
 *  - `inferred`  our own heuristic. MUST be visibly labelled wherever shown
 *  - `manual`    a human typed it
 */
export const PROVENANCE_CONFIDENCE = ['declared', 'derived', 'inferred', 'manual'] as const;
export type ProvenanceConfidence = (typeof PROVENANCE_CONFIDENCE)[number];

/**
 * The reporting semantics of a pipeline stage.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE STAGE NAME
 * So that reporting never depends on a stage literally being called "Won". A
 * workspace may rename its stages to "Job Booked" or "Deal Signed"; win rate
 * must keep working.
 */
export const STAGE_CATEGORIES = ['open', 'won', 'lost'] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

/** Mirrors the category of the stage an opportunity currently occupies. */
export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * Task lifecycle.
 *
 * `cancelled` rather than deletion: "this no longer needs doing" is a real
 * outcome and belongs in history (ADR-0013).
 */
export const TASK_STATUSES = ['open', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Who or what performed an action.
 *
 * Present from Stage 2 so that AI- and automation-originated records are
 * representable before either exists. Retrofitting an actor type onto a
 * populated activity table would mean guessing at history.
 */
export const ACTOR_TYPES = ['user', 'agent', 'automation', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Activity timeline event names, `entity.past_tense_verb`.
 *
 * Stored as TEXT, not a PostgreSQL enum: this set grows with every feature
 * shipped, and a native enum would require a migration per addition. The
 * database does not constrain the value because it is descriptive and carries
 * no authorization weight.
 */
export const ACTIVITY_TYPES = {
  CONTACT_CREATED: 'contact.created',
  CONTACT_UPDATED: 'contact.updated',
  CONTACT_ARCHIVED: 'contact.archived',
  CONTACT_RESTORED: 'contact.restored',
  ACQUISITION_RECORDED: 'acquisition.recorded',
  ACQUISITION_QUALIFIED: 'acquisition.qualified',
  OPPORTUNITY_CREATED: 'opportunity.created',
  OPPORTUNITY_STAGE_CHANGED: 'opportunity.stage_changed',
  OPPORTUNITY_WON: 'opportunity.won',
  OPPORTUNITY_LOST: 'opportunity.lost',
  TASK_CREATED: 'task.created',
  TASK_COMPLETED: 'task.completed',
  TASK_CANCELLED: 'task.cancelled',
  NOTE_ADDED: 'note.added',
} as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[keyof typeof ACTIVITY_TYPES];

/** Currencies accepted at Stage 2. Deliberately short; extend as customers need. */
export const CURRENCIES = ['AUD', 'NZD', 'USD', 'GBP', 'EUR', 'CAD'] as const;
export type Currency = (typeof CURRENCIES)[number];
