/**
 * The public submission service.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The whole Stage 3 product loop, in one function:
 *
 *   anonymous submission
 *     → resolve the form, and therefore the tenant
 *     → abuse controls
 *     → validate against the PUBLISHED version's field list
 *     → map values onto CRM identity
 *     → classify the source deterministically from raw signals
 *     → ingestAcquisition(...)          ← the CRM owns every CRM write
 *     → record a receipt
 *
 * ⚠️ THE RULE THIS FILE EXISTS TO KEEP
 * **It never inserts a contact, an acquisition or an opportunity.** Those
 * belong to `ingestAcquisition`, which owns matching, idempotency, provenance
 * integrity and atomicity. A second ingestion path would mean two answers to
 * "how is a lead deduplicated?" and attribution would depend on which one ran
 * (ADR-0021).
 *
 * The only rows written here are the submission receipt and, through the CRM,
 * whatever ingestion decides.
 *
 * @see docs/architecture/lead-capture-architecture.md
 */

import {
  ConflictError,
  classifySource,
  CUSTOM_FIELD_TARGET_PREFIX,
  type FormFieldConfig,
  type PublicSubmissionInput,
  type RejectionReason,
  type DomainEventPublisher,
  type SuccessBehaviour,
  type TenantActor,
} from '@growth-os/contracts';
import { ingestAcquisition, type CrmContext } from '@growth-os/crm';
import { schemaTables, type Database } from '@growth-os/database';
import { withTenantTransaction } from '@growth-os/database';
import {
  consumePublicRateLimit,
  evaluateAbuseSignals,
  type SubmissionChallengeVerifier,
} from './abuse';
import { honeypotKeyFor } from './honeypot';
import { isFirstPartyOrigin, isOriginAllowed } from '../shared/origin';
import { sanitiseContext } from '../tracking/sanitise';
import type { ResolvedForm } from './resolve';

const { formSubmissions } = schemaTables;

/** The source system recorded on every receipt a public form writes. */
export const PUBLIC_FORM_SOURCE_SYSTEM = 'website_form';

export interface SubmitDependencies {
  readonly db: Database;
  readonly events: DomainEventPublisher;
  readonly challenge: SubmissionChallengeVerifier;
  /** The application's own origin. Always permitted, for the hosted form. */
  readonly appUrl: string;
  readonly now?: () => Date;
}

export interface SubmitRequest {
  readonly form: ResolvedForm;
  readonly input: PublicSubmissionInput;
  readonly ipAddress: string;
  readonly origin: string | null;
  readonly correlationId: string | null;
}

export type SubmitResult =
  | { readonly kind: 'accepted'; readonly reference: string; readonly success: SuccessBehaviour }
  | { readonly kind: 'rejected'; readonly reason: RejectionReason };

/**
 * Build the CRM context for a public submission.
 *
 * A SYSTEM ACTOR, granted exactly one capability (ADR-0025). Not a role: the
 * weakest role holding `contacts:write` is `member`, which also holds four
 * capabilities this path must never use.
 *
 * The workspace is real and the transaction is tenant-scoped, so RLS applies
 * exactly as it does for a human operator. The grant governs capability, never
 * isolation.
 */
export function systemCrmContext(
  deps: SubmitDependencies,
  workspaceId: string,
  formId: string,
  correlationId: string | null,
): CrmContext {
  const workspace = {
    workspaceId,
    workspaceName: '',
    workspaceSlug: '',
    agencyId: null,
    // Never consulted — the grant below decides. Set to the WEAKEST role so
    // that if the grant branch were ever removed, the fallback is
    // least-privilege rather than most (ADR-0025 §3).
    role: 'viewer' as const,
    via: 'direct' as const,
  };

  const tenant: TenantActor = {
    actor: {
      // No user exists. `actorUserId` THROWS on a system context, so nothing
      // can read this and write it into a foreign key; `actorUserIdOrNull`
      // returns null, which is the honest value for `created_by_user_id`.
      userId: '',
      email: '',
      name: '',
      sessionId: '',
      workspaces: [workspace],
      agencies: [],
    },
    workspace,
  };

  return {
    deps: { db: deps.db, events: deps.events, ...(deps.now ? { now: deps.now } : {}) },
    tenant,
    correlationId,
    system: {
      label: `public_form:${formId}`,
      capabilities: ['workspace:crm:contacts:write'],
    },
  };
}

/**
 * Process one public submission.
 *
 * Returns a rejection REASON for the operator's receipt. The caller renders one
 * identical public message for every reason — the distinction exists so an
 * operator can see "47 rejected: honeypot" in their submissions list, not so a
 * bot can learn which signal caught it.
 */
export async function submitPublicForm(
  deps: SubmitDependencies,
  request: SubmitRequest,
): Promise<SubmitResult> {
  const { form, input } = request;
  const now = deps.now?.() ?? new Date();

  const reject = async (reason: RejectionReason): Promise<SubmitResult> => {
    await recordReceipt(deps, form, {
      outcome: 'rejected',
      rejectionReason: reason,
      now,
      diagnostics: { bytes: approximateBytes(input) },
    });
    return { kind: 'rejected', reason };
  };

  // 1. STATUS. A draft or paused form accepts nothing. Checked before any
  //    other work, because everything after it would be wasted.
  if (form.status !== 'active') return reject('form_not_accepting');

  // 2. ORIGIN. Abuse reduction only — `Origin` is forgeable by anything that
  //    is not a browser (ADR-0026 §5). The app's own origin is always allowed,
  //    or configuring an allow-list would silently break the hosted form.
  if (
    !isFirstPartyOrigin(request.origin, deps.appUrl) &&
    !isOriginAllowed(request.origin, form.settings.allowedOrigins)
  ) {
    return reject('origin_not_allowed');
  }

  // 3. RATE LIMITS, before validation: a flood must be cheap to refuse.
  const limit = await consumePublicRateLimit(deps.db, {
    ipAddress: request.ipAddress,
    formId: form.formId,
    now,
  });
  if (!limit.allowed) return reject('rate_limited');

  // 4. CONTENT SIGNALS. Cheap, weak, and explicitly not "bot detection".
  const signal = evaluateAbuseSignals({
    honeypotEnabled: form.settings.honeypotEnabled,
    honeypotKey: form.settings.honeypotEnabled ? honeypotKeyFor(form.versionId) : null,
    trap: input.trap,
    elapsedMs: input.context.elapsedMs,
    minSubmitSeconds: form.settings.minSubmitSeconds,
  });
  if (signal) return reject(signal);

  // 5. CHALLENGE, when a provider is configured. The default accepts.
  if (!(await deps.challenge.verify(input.challengeToken, { ipAddress: request.ipAddress }))) {
    return reject('challenge_failed');
  }

  // 6. VALIDATE against the PUBLISHED version's fields — not against whatever
  //    the client sent. A field the version does not declare is ignored
  //    entirely, so a crafted payload cannot introduce one.
  const mapped = mapValues(form.fields, input.values);
  if (mapped.missingRequired.length > 0) return reject('validation_failed');

  // 7. IDENTITY. Ingestion needs an email or a phone to match on. A form is
  //    checked for this at publish time, so reaching here means the visitor
  //    left both blank on optional fields.
  if (!mapped.identity.email && !mapped.identity.phone) return reject('identity_missing');

  // 8. PROVENANCE, derived by DETERMINISTIC CODE from raw browser signals.
  //    The browser cannot state `sourceType`, `confidence` or `searchQuery` —
  //    those are not in the submission schema at all.
  const context = sanitiseContext(input.context);
  const classified = classifySource(context);

  const crm = systemCrmContext(deps, form.workspaceId, form.formId, request.correlationId);

  try {
    const result = await ingestAcquisition(crm, {
      identity: {
        firstName: mapped.identity.firstName ?? 'Website enquiry',
        ...(mapped.identity.lastName ? { lastName: mapped.identity.lastName } : {}),
        ...(mapped.identity.email ? { email: mapped.identity.email } : {}),
        ...(mapped.identity.phone ? { phone: mapped.identity.phone } : {}),
        ...(mapped.identity.companyName ? { companyName: mapped.identity.companyName } : {}),
      },
      provenance: {
        sourceType: classified.sourceType,
        sourcePlatform: classified.sourcePlatform,
        confidence: classified.confidence,
        ...(context.landingPath ? { landingPath: context.landingPath } : {}),
        ...(context.referrerOrigin ? { referrerOrigin: context.referrerOrigin } : {}),
        ...(context.utmSource ? { utmSource: context.utmSource } : {}),
        ...(context.utmMedium ? { utmMedium: context.utmMedium } : {}),
        ...(context.utmCampaign ? { utmCampaign: context.utmCampaign } : {}),
        ...(context.utmTerm ? { utmTerm: context.utmTerm } : {}),
        ...(context.utmContent ? { utmContent: context.utmContent } : {}),
        ...(context.gclid ? { gclid: context.gclid } : {}),
        ...(context.fbclid ? { fbclid: context.fbclid } : {}),
        // ⚠️ NO `searchQuery`. Search engines have not passed the query in the
        // referrer since 2011. `utm_term` is the marketer's bid keyword, not
        // the visitor's search — inferring one from the other is the exact
        // fabrication ADR-0012 exists to prevent.
        channelDetail: mapped.note ?? form.name,
        metadata: {
          formVersion: form.version,
          ...(context.submissionPath ? { submissionPath: context.submissionPath } : {}),
        },
      },
      // The client's own submission id, scoped to this form. Only the client
      // knows a retry is the SAME submission rather than a second one.
      idempotency: {
        sourceSystem: PUBLIC_FORM_SOURCE_SYSTEM,
        externalKey: `${form.formId}:${input.submissionId}`,
      },
      matchPolicy: 'match_then_create',
      ...(form.settings.opportunity.enabled
        ? {
            opportunity: {
              title: renderTitle(form.settings.opportunity.titleTemplate, {
                contact: [mapped.identity.firstName, mapped.identity.lastName]
                  .filter(Boolean)
                  .join(' '),
                form: form.name,
                company: mapped.identity.companyName ?? '',
              }),
              ...(form.settings.opportunity.pipelineId
                ? { pipelineId: form.settings.opportunity.pipelineId }
                : {}),
              ...(form.settings.opportunity.estimatedValueMinor !== undefined
                ? { estimatedValueMinor: form.settings.opportunity.estimatedValueMinor }
                : {}),
            },
          }
        : {}),
      trust: {
        ...(request.origin ? { origin: request.origin } : {}),
        submittedAt: now.toISOString(),
        assessment: 'unverified',
      },
    });

    await recordReceipt(deps, form, {
      outcome: result.outcome,
      now,
      contactId: result.contactId,
      acquisitionId: result.acquisitionId,
      opportunityId: result.opportunityId,
      matchedExisting: result.match === 'matched_existing',
      sourceType: classified.sourceType,
      diagnostics: {
        bytes: approximateBytes(input),
        rationale: classified.rationale,
      },
    });

    return {
      kind: 'accepted',
      reference: input.submissionId,
      success: form.settings.success,
    };
  } catch (error) {
    // A reused submission id with DIFFERENT content. Ingestion refuses rather
    // than silently replaying, because returning the original result could
    // attach one person's details to another's acquisition (ADR-0021 §3).
    if (error instanceof ConflictError) {
      await recordReceipt(deps, form, {
        outcome: 'rejected',
        rejectionReason: 'validation_failed',
        now,
        diagnostics: { bytes: approximateBytes(input), conflict: true },
      });
      throw error;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

export interface MappedValues {
  readonly identity: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    companyName?: string;
  };
  /** Free text mapped to `note`, joined. Becomes the acquisition's detail. */
  readonly note: string | null;
  /** `custom:<key>` targets, for a later stage to apply. */
  readonly customFields: Readonly<Record<string, string>>;
  readonly missingRequired: readonly string[];
}

/**
 * Map submitted values onto CRM identity, driven by the VERSION's field list.
 *
 * ⚠️ The version decides, not the payload. A key the version does not declare
 * is never read, so a crafted submission cannot introduce a field — the same
 * closed-allow-list rule as CSV import (ADR-0023 §5).
 */
export function mapValues(
  fields: readonly FormFieldConfig[],
  values: Record<string, string | boolean>,
): MappedValues {
  const identity: MappedValues['identity'] = {};
  const customFields: Record<string, string> = {};
  const missingRequired: string[] = [];
  const notes: string[] = [];

  for (const field of fields) {
    const raw = values[field.key];
    const value =
      typeof raw === 'string' ? raw.trim().slice(0, field.maxLength) : raw === true ? 'Yes' : '';

    if (field.required && value.length === 0) {
      missingRequired.push(field.key);
      continue;
    }
    if (value.length === 0) continue;

    // A `select` value must be one the version declares. Otherwise a crafted
    // payload writes arbitrary text into a field the operator believes is a
    // controlled vocabulary.
    if (field.type === 'select' && field.options && !field.options.includes(value)) {
      missingRequired.push(field.key);
      continue;
    }

    if (field.target.startsWith(CUSTOM_FIELD_TARGET_PREFIX)) {
      customFields[field.target.slice(CUSTOM_FIELD_TARGET_PREFIX.length)] = value;
      continue;
    }

    switch (field.target) {
      case 'firstName':
        identity.firstName = value;
        break;
      case 'lastName':
        identity.lastName = value;
        break;
      case 'email':
        identity.email = value;
        break;
      case 'phone':
        identity.phone = value;
        break;
      case 'companyName':
        identity.companyName = value;
        break;
      case 'note':
        // The LABEL is included, so a two-field enquiry stays readable in the
        // CRM rather than becoming two anonymous paragraphs.
        notes.push(`${field.label}: ${value}`);
        break;
      case 'none':
        break;
    }
  }

  return {
    identity,
    note: notes.length > 0 ? notes.join(' · ').slice(0, 255) : null,
    customFields,
    missingRequired,
  };
}

/**
 * Expand an opportunity title template.
 *
 * A TINY CONTROLLED VOCABULARY, expanded by literal replacement. There is no
 * expression language and no evaluation: a template that could evaluate would
 * be remote code execution configured through a web form.
 */
export function renderTitle(
  template: string,
  values: { contact: string; form: string; company: string },
): string {
  const rendered = template
    .replaceAll('{contact}', values.contact || 'Website visitor')
    .replaceAll('{form}', values.form)
    .replaceAll('{company}', values.company);
  // Any unrecognised placeholder is left literal rather than silently dropped,
  // so a typo in the template is visible on the deal instead of invisible.
  return rendered.trim().slice(0, 200) || 'Website enquiry';
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

interface ReceiptInput {
  readonly outcome: 'created' | 'duplicate' | 'rejected';
  readonly now: Date;
  readonly rejectionReason?: RejectionReason;
  readonly contactId?: string;
  readonly acquisitionId?: string;
  readonly opportunityId?: string | null;
  readonly matchedExisting?: boolean;
  readonly sourceType?: string;
  readonly diagnostics?: Record<string, string | number | boolean>;
}

/**
 * Record that a submission happened, and how it resolved.
 *
 * ⚠️ WHAT THE VISITOR TYPED IS NOT WRITTEN HERE. The receipt carries counts,
 * ids, an outcome and a byte size. What they typed became the contact, the
 * acquisition and the opportunity — which erasure governs. A submission
 * archive would be a second, richer copy of every enquiry a business ever
 * received, sitting outside erasure's reach (ADR-0021 §4).
 */
async function recordReceipt(
  deps: SubmitDependencies,
  form: ResolvedForm,
  input: ReceiptInput,
): Promise<void> {
  await withTenantTransaction(deps.db, form.workspaceId, async (tx) => {
    await tx.insert(formSubmissions).values({
      workspaceId: form.workspaceId,
      formId: form.formId,
      formVersionId: form.versionId,
      outcome: input.outcome,
      contactId: input.contactId ?? null,
      acquisitionId: input.acquisitionId ?? null,
      opportunityId: input.opportunityId ?? null,
      matchedExisting: input.matchedExisting ?? false,
      sourceType: input.sourceType ?? null,
      rejectionReason: input.rejectionReason ?? null,
      diagnostics: input.diagnostics ?? null,
      createdAt: input.now,
    });
  });

  // Built as two distinct literals rather than one with a conditional `name`.
  // A union member has to be constructible on its own, and a spread-built
  // object would only be assignable by widening the event type — which is how
  // a rejected submission ends up carrying an acquisition id.
  const base = {
    workspaceId: form.workspaceId,
    occurredAt: input.now.toISOString(),
    correlationId: null,
    actorType: 'system',
    actorUserId: null,
    formId: form.formId,
  } as const;

  if (input.outcome === 'rejected') {
    deps.events.publish({
      ...base,
      name: 'forms.submission.rejected',
      outcome: 'rejected',
      ...(input.rejectionReason ? { reason: input.rejectionReason } : {}),
    });
  } else {
    deps.events.publish({
      ...base,
      name: 'forms.submission.received',
      outcome: input.outcome,
      ...(input.acquisitionId ? { acquisitionId: input.acquisitionId } : {}),
    });
  }
}

/** Approximate payload size, for diagnostics. Never the payload itself. */
function approximateBytes(input: PublicSubmissionInput): number {
  return JSON.stringify(input.values).length;
}
