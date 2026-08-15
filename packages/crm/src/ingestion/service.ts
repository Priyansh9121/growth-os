/**
 * The canonical ingestion boundary.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * ONE path through which every automated write enters the CRM. Website forms,
 * tracked calls, voice AI, ad-platform webhooks, the public API and CSV import
 * all call `ingestAcquisition`.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS
 * If each channel implemented its own create-or-match, they would differ — in
 * dedup behaviour, in the provenance confidence they claim, in whether they
 * are safe to retry. Attribution would then depend on which integration
 * happened to write the row, which is the same as attribution not working.
 *
 * IDEMPOTENCY IS NOT OPTIONAL BEHAVIOUR, IT IS THE POINT
 * Every automated caller retries. Webhook providers retry on timeout, browsers
 * retry on flaky connections, import runs get re-run. Without a receipt, a
 * retried submission creates a second acquisition and inflates the exact
 * metric this product is sold on.
 *
 * The receipt, the contact, the acquisition, the opportunity and the timeline
 * entry all commit together. A receipt written for an ingestion that rolled
 * back would make the retry report "already done" and lose the lead
 * permanently — the worst failure this subsystem can have.
 *
 * @see docs/decisions/ADR-0021-ingestion-and-idempotency.md
 */

import { createHash } from 'node:crypto';
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  assertProvenanceIntegrity,
  ConflictError,
  ValidationError,
  type IngestAcquisitionParsed,
  type IngestionResult,
} from '@growth-os/contracts';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import { displayName, normaliseEmail, normalisePhone } from '../identity/normalise';
import {
  actorUserId,
  contextNow,
  inTenant,
  requireCapability,
  tenantScope,
  workspaceId,
  type CrmContext,
} from '../shared/context';
import { recordActivity } from '../activities/service';
import { insertAcquisition } from '../acquisitions/service';

const {
  companies,
  contacts,
  ingestionReceipts,
  opportunities,
  pipelines,
  pipelineStages,
  workspaces,
} = schemaTables;

type Tx = TenantTransaction;

/**
 * Ingest one lead.
 *
 * Requires `contacts:write` — the same capability as manual creation. An
 * automated path must not be able to do more than a person can, which is what
 * would happen if ingestion carried its own weaker check.
 */
export async function ingestAcquisition(
  context: CrmContext,
  input: IngestAcquisitionParsed,
): Promise<IngestionResult> {
  requireCapability(context, 'workspace:crm:contacts:write');

  // Provenance integrity is asserted BEFORE the transaction opens: a
  // fabricated `searchQuery` must fail loudly rather than roll back halfway.
  try {
    assertProvenanceIntegrity(input.provenance);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'Invalid provenance.');
  }

  const now = contextNow(context);

  const outcome = await inTenant(context, (tx, workspace) =>
    ingestInTransaction(context, tx, workspace, input, now),
  );

  // A `duplicate` outcome publishes NOTHING. The retry made no new facts, and
  // re-emitting would let a retrying webhook inflate downstream counters even
  // though the database correctly refused to create a second row.
  if (outcome.outcome === 'created') {
    context.deps.events.publish({
      name: 'crm.acquisition.ingested',
      workspaceId: workspaceId(context),
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      actorType: 'automation',
      actorUserId: null,
      acquisitionId: outcome.acquisitionId,
      contactId: outcome.contactId,
      opportunityId: outcome.opportunityId,
      sourceType: input.provenance.sourceType,
      match: outcome.match,
      sourceSystem: input.idempotency?.sourceSystem ?? null,
    });
  }

  return outcome;
}

/**
 * The transactional core, exported so bulk import can drive many ingestions
 * inside ONE transaction per chunk rather than one transaction per row.
 *
 * Ten thousand single-row transactions is ten thousand round trips; one
 * transaction over ten thousand rows holds locks far too long. The chunk is
 * the compromise, and it needs this seam to exist (ADR-0023 §2).
 */
export async function ingestInTransaction(
  context: CrmContext,
  tx: Tx,
  workspace: string,
  input: IngestAcquisitionParsed,
  now: Date,
): Promise<IngestionResult> {
  const region = await phoneRegion(tx, workspace);
  const emailNormalised = normaliseEmail(input.identity.email);
  const phoneE164 = normalisePhone(input.identity.phone, region);

  const digest = requestDigest(input, emailNormalised, phoneE164);

  if (input.idempotency) {
    const replay = await findReceipt(tx, workspace, input.idempotency, digest);
    if (replay) return replay;
  }

  const match =
    input.matchPolicy === 'always_create'
      ? null
      : await findLiveContact(tx, workspace, emailNormalised, phoneE164);

  const contactId =
    match ??
    (await createContactRow(context, tx, workspace, input, {
      emailNormalised,
      phoneE164,
      now,
    }));

  const acquisitionId = await insertAcquisition(context, tx, {
    contactId,
    provenance: input.provenance,
    capturedAt: now,
  });

  const opportunityId = input.opportunity
    ? await createOpportunityRow(context, tx, workspace, contactId, acquisitionId, input, now)
    : null;

  if (input.idempotency) {
    await writeReceipt(tx, workspace, input.idempotency, digest, {
      contactId,
      acquisitionId,
      opportunityId,
    });
  }

  return {
    outcome: 'created',
    match: match === null ? 'created_new' : 'matched_existing',
    contactId,
    acquisitionId,
    opportunityId,
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Fingerprint of what this request MEANS, not of the bytes it arrived as.
 *
 * Built from the normalised identity and the provenance fields only. A
 * provider that adds a tracking field, reorders its JSON or changes its
 * whitespace must not turn a legitimate retry into a conflict — which is
 * exactly what hashing the raw payload would do.
 */
function requestDigest(
  input: IngestAcquisitionParsed,
  emailNormalised: string | null,
  phoneE164: string | null,
): string {
  const material = JSON.stringify([
    emailNormalised,
    phoneE164,
    input.identity.firstName.trim().toLowerCase(),
    (input.identity.lastName ?? '').trim().toLowerCase(),
    input.provenance.sourceType,
    input.provenance.sourcePlatform,
    input.provenance.confidence,
    input.provenance.utmSource ?? null,
    input.provenance.utmMedium ?? null,
    input.provenance.utmCampaign ?? null,
  ]);
  return createHash('sha256').update(material).digest('hex');
}

async function findReceipt(
  tx: Tx,
  workspace: string,
  key: NonNullable<IngestAcquisitionParsed['idempotency']>,
  digest: string,
): Promise<IngestionResult | null> {
  const [existing] = await tx
    .select({
      requestDigest: ingestionReceipts.requestDigest,
      contactId: ingestionReceipts.contactId,
      acquisitionId: ingestionReceipts.acquisitionId,
      opportunityId: ingestionReceipts.opportunityId,
    })
    .from(ingestionReceipts)
    .where(
      and(
        tenantScope(ingestionReceipts, workspace),
        eq(ingestionReceipts.sourceSystem, key.sourceSystem),
        eq(ingestionReceipts.externalKey, key.externalKey),
      ),
    )
    .limit(1);

  if (!existing) return null;

  // Same key, DIFFERENT content. Returning the original result here would hide
  // a real integration bug and could attach one person's data to another
  // person's acquisition. Conflict is the honest answer (ADR-0021 §3).
  if (existing.requestDigest !== digest) {
    throw new ConflictError(
      `Idempotency key ${key.sourceSystem}:${key.externalKey} was already used with different content`,
      'This submission reuses an identifier that was already recorded with different details.',
    );
  }

  if (!existing.contactId || !existing.acquisitionId) {
    // A receipt whose rows have since been detached. Not recoverable as a
    // replay, and silently re-ingesting would defeat the key.
    throw new ConflictError(
      `Receipt ${key.sourceSystem}:${key.externalKey} no longer resolves to its original records`,
      'This submission was already processed, but its records are no longer available.',
    );
  }

  return {
    outcome: 'duplicate',
    match: 'matched_existing',
    contactId: existing.contactId,
    acquisitionId: existing.acquisitionId,
    opportunityId: existing.opportunityId,
  };
}

async function writeReceipt(
  tx: Tx,
  workspace: string,
  key: NonNullable<IngestAcquisitionParsed['idempotency']>,
  digest: string,
  ids: { contactId: string; acquisitionId: string; opportunityId: string | null },
): Promise<void> {
  // The unique index is the real guard. Two concurrent retries can both pass
  // the SELECT above; only one can insert, and the other's transaction fails
  // and is retried by the caller — which then finds the receipt.
  await tx.insert(ingestionReceipts).values({
    workspaceId: workspace,
    sourceSystem: key.sourceSystem,
    externalKey: key.externalKey,
    requestDigest: digest,
    contactId: ids.contactId,
    acquisitionId: ids.acquisitionId,
    opportunityId: ids.opportunityId,
  });
}

// ---------------------------------------------------------------------------
// Matching and creation
// ---------------------------------------------------------------------------

/**
 * Find a live contact by exact normalised email or phone.
 *
 * Exact only. Fuzzy matching would silently attach one person's enquiry to
 * another's record, and unlike a duplicate contact that is not something an
 * operator can later notice and fix.
 *
 * Merged and erased contacts are excluded: a tombstone is a redirect, not a
 * person, and an erased contact has no identity left to match.
 */
async function findLiveContact(
  tx: Tx,
  workspace: string,
  emailNormalised: string | null,
  phoneE164: string | null,
): Promise<string | null> {
  const identity: SQL[] = [];
  if (emailNormalised) identity.push(eq(contacts.emailNormalised, emailNormalised));
  if (phoneE164) identity.push(eq(contacts.phoneE164, phoneE164));
  if (identity.length === 0) return null;

  const matcher = identity.length === 1 ? identity[0] : or(...identity);
  if (!matcher) return null;

  const [row] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        tenantScope(contacts, workspace),
        isNull(contacts.deletedAt),
        isNull(contacts.mergedAt),
        isNull(contacts.erasedAt),
        matcher,
      ),
    )
    // Oldest first: when a workspace already holds two records for the same
    // address, the established one is the one with the history on it.
    .orderBy(contacts.createdAt)
    .limit(1);

  return row?.id ?? null;
}

async function createContactRow(
  context: CrmContext,
  tx: Tx,
  workspace: string,
  input: IngestAcquisitionParsed,
  derived: { emailNormalised: string | null; phoneE164: string | null; now: Date },
): Promise<string> {
  const companyId = input.identity.companyName
    ? await findOrCreateCompany(context, tx, workspace, input.identity.companyName, derived.now)
    : null;

  const [row] = await tx
    .insert(contacts)
    .values({
      workspaceId: workspace,
      firstName: input.identity.firstName,
      lastName: input.identity.lastName ?? null,
      email: input.identity.email ?? null,
      emailNormalised: derived.emailNormalised,
      phone: input.identity.phone ?? null,
      phoneE164: derived.phoneE164,
      companyId,
      // Unowned on purpose. An automated lead has no natural owner, and
      // assigning one arbitrarily makes an assignment rule look like a
      // decision somebody made.
      ownerUserId: null,
      createdByUserId: actorUserId(context),
      createdAt: derived.now,
      updatedAt: derived.now,
    })
    .returning({ id: contacts.id });

  if (!row) throw new Error('Failed to insert contact during ingestion');

  await recordActivity(context, tx, {
    type: ACTIVITY_TYPES.CONTACT_CREATED,
    summary: `${displayName(input.identity.firstName, input.identity.lastName ?? null)} added`,
    contactId: row.id,
    actorType: 'automation',
    occurredAt: derived.now,
  });

  return row.id;
}

/**
 * Resolve a company by name, creating it if this workspace has none.
 *
 * MATCHED CASE-INSENSITIVELY ON NAME, AND ONLY ON NAME.
 *
 * That is a weak key and it is chosen deliberately. The alternative — creating
 * a fresh company row per incoming lead — produces "ABC Plumbing", "abc
 * plumbing" and "ABC  Plumbing" as three organisations within a week of
 * enabling a web form, which no operator will ever untangle.
 *
 * The failure mode of matching (two genuinely different businesses sharing a
 * name land on one record) is visible on the company page and fixable by
 * renaming. The failure mode of not matching is silent and unbounded.
 */
async function findOrCreateCompany(
  context: CrmContext,
  tx: Tx,
  workspace: string,
  name: string,
  now: Date,
): Promise<string | null> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;

  const [existing] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        tenantScope(companies, workspace),
        isNull(companies.deletedAt),
        sql`lower(${companies.name}) = lower(${trimmed})`,
      ),
    )
    .orderBy(companies.createdAt)
    .limit(1);

  if (existing) return existing.id;

  const [created] = await tx
    .insert(companies)
    .values({
      workspaceId: workspace,
      name: trimmed,
      createdByUserId: actorUserId(context),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: companies.id });

  return created?.id ?? null;
}

async function createOpportunityRow(
  context: CrmContext,
  tx: Tx,
  workspace: string,
  contactId: string,
  acquisitionId: string,
  input: IngestAcquisitionParsed,
  now: Date,
): Promise<string> {
  const deal = input.opportunity;
  if (!deal) throw new Error('createOpportunityRow called without an opportunity');

  const pipeline = await resolvePipeline(tx, workspace, deal.pipelineId);
  const stage = await firstStage(tx, workspace, pipeline.id);

  const [row] = await tx
    .insert(opportunities)
    .values({
      workspaceId: workspace,
      title: deal.title,
      contactId,
      pipelineId: pipeline.id,
      stageId: stage.id,
      status: 'open',
      estimatedValueMinor: deal.estimatedValueMinor ?? 0,
      currency: pipeline.currency,
      // THE ATTRIBUTION JOIN, set at creation. Linking the deal to the
      // acquisition that produced it later, by inference, is exactly the guess
      // the provenance model exists to avoid.
      acquisitionId,
      createdByUserId: actorUserId(context),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: opportunities.id });

  if (!row) throw new Error('Failed to insert opportunity during ingestion');

  await recordActivity(context, tx, {
    type: ACTIVITY_TYPES.OPPORTUNITY_CREATED,
    summary: `Opportunity created — ${deal.title}`,
    contactId,
    opportunityId: row.id,
    actorType: 'automation',
    occurredAt: now,
  });

  return row.id;
}

async function resolvePipeline(
  tx: Tx,
  workspace: string,
  pipelineId: string | undefined,
): Promise<{ id: string; currency: 'AUD' | 'NZD' | 'USD' | 'GBP' | 'EUR' | 'CAD' }> {
  const [row] = await tx
    .select({ id: pipelines.id, currency: pipelines.currency })
    .from(pipelines)
    .where(
      and(
        tenantScope(pipelines, workspace),
        isNull(pipelines.archivedAt),
        pipelineId ? eq(pipelines.id, pipelineId) : eq(pipelines.isDefault, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ValidationError(
      pipelineId
        ? 'That pipeline does not exist in this workspace.'
        : 'This workspace has no default pipeline, so a deal cannot be opened automatically.',
    );
  }
  return row;
}

async function firstStage(tx: Tx, workspace: string, pipelineId: string): Promise<{ id: string }> {
  const [row] = await tx
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(
      and(
        tenantScope(pipelineStages, workspace),
        eq(pipelineStages.pipelineId, pipelineId),
        isNull(pipelineStages.archivedAt),
      ),
    )
    .orderBy(pipelineStages.position)
    .limit(1);

  if (!row) throw new ValidationError('That pipeline has no open stages.');
  return row;
}

async function phoneRegion(tx: Tx, workspace: string): Promise<string> {
  const [row] = await tx
    .select({ region: workspaces.defaultPhoneRegion })
    .from(workspaces)
    .where(eq(workspaces.id, workspace))
    .limit(1);
  return row?.region ?? 'AU';
}

/**
 * How many acquisitions this workspace has ingested from a given source
 * system. Used by the import results screen and by operational checks.
 */
export async function countIngestedFrom(
  context: CrmContext,
  sourceSystem: string,
): Promise<number> {
  requireCapability(context, 'workspace:crm:contacts:read');

  return inTenant(context, async (tx, workspace) => {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(ingestionReceipts)
      .where(
        and(
          tenantScope(ingestionReceipts, workspace),
          eq(ingestionReceipts.sourceSystem, sourceSystem),
        ),
      );
    return row?.total ?? 0;
  });
}
