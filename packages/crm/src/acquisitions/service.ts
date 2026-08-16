/**
 * Acquisition service — the provenance write path.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single path through which any source records how a person entered
 * Growth OS. Website forms, tracked calls, voice AI, imports, the API and
 * manual entry all funnel through `insertAcquisition`, so every one of them
 * produces the same validated shape.
 *
 * THE INVARIANT THIS FILE DEFENDS
 * `searchQuery` may only be persisted when a source system declared it.
 * Checked here in application code AND enforced by the database trigger in
 * migration 0003. Belt and braces, because a fabricated keyword corrupts the
 * exact number the whole product is sold on.
 *
 * @see docs/decisions/ADR-0012-provenance-model.md
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  assertProvenanceIntegrity,
  SOURCE_TYPE_LABELS,
  ValidationError,
  type AcquisitionView,
  type Provenance,
} from '@growth-os/contracts';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import {
  actorUserId,
  actorUserIdOrNull,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  workspaceId,
  type CrmContext,
} from '../shared/context';
import { recordActivity } from '../activities/service';

const { acquisitions, contacts } = schemaTables;

export interface InsertAcquisitionInput {
  readonly contactId: string;
  readonly provenance: Provenance;
  readonly capturedAt?: Date | undefined;
}

/**
 * Insert an acquisition inside an existing transaction.
 *
 * Takes the caller's transaction because it is nearly always part of a larger
 * atomic operation — most importantly contact creation, where a contact
 * without its provenance is the precise data loss this model prevents.
 */
export async function insertAcquisition(
  context: CrmContext,
  tx: TenantTransaction,
  input: InsertAcquisitionInput,
): Promise<string> {
  try {
    assertProvenanceIntegrity(input.provenance);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'Invalid provenance.');
  }

  const workspace = workspaceId(context);
  const capturedAt = input.capturedAt ?? contextNow(context);
  const provenance = input.provenance;

  // Is this the contact's first acquisition? Determined before insert, and
  // used for the first-touch flag on the emitted event.
  const [{ existing = 0 } = {}] = await tx
    .select({ existing: sql<number>`count(*)::int` })
    .from(acquisitions)
    .where(eq(acquisitions.contactId, input.contactId));

  const [row] = await tx
    .insert(acquisitions)
    .values({
      workspaceId: workspace,
      contactId: input.contactId,
      sourceType: provenance.sourceType,
      sourcePlatform: provenance.sourcePlatform,
      confidence: provenance.confidence,
      landingPath: provenance.landingPath ?? null,
      referrerOrigin: provenance.referrerOrigin ?? null,
      utmSource: provenance.utmSource ?? null,
      utmMedium: provenance.utmMedium ?? null,
      utmCampaign: provenance.utmCampaign ?? null,
      utmTerm: provenance.utmTerm ?? null,
      utmContent: provenance.utmContent ?? null,
      gclid: provenance.gclid ?? null,
      fbclid: provenance.fbclid ?? null,
      // Null unless declared. `assertProvenanceIntegrity` above has already
      // rejected any other combination.
      searchQuery: provenance.searchQuery ?? null,
      channelDetail: provenance.channelDetail ?? null,
      metadata: provenance.metadata ?? null,
      capturedAt,
    })
    .returning({ id: acquisitions.id });

  if (!row) throw new Error('Failed to insert acquisition');

  await recordActivity(context, tx, {
    type: ACTIVITY_TYPES.ACQUISITION_RECORDED,
    summary: `Lead captured — ${SOURCE_TYPE_LABELS[provenance.sourceType]}`,
    detail: provenance.landingPath ?? provenance.channelDetail ?? undefined,
    contactId: input.contactId,
    acquisitionId: row.id,
    occurredAt: capturedAt,
  });

  context.deps.events.publish({
    name: 'crm.acquisition.recorded',
    workspaceId: workspace,
    occurredAt: capturedAt.toISOString(),
    correlationId: context.correlationId,
    // Follows the context, like the timeline entry above. An event claiming a
    // `user` recorded a public form submission would be wrong in the one place
    // subscribers cannot check it.
    actorType: context.system ? 'system' : 'user',
    actorUserId: actorUserIdOrNull(context),
    acquisitionId: row.id,
    contactId: input.contactId,
    sourceType: provenance.sourceType,
    isFirstTouch: existing === 0,
  });

  return row.id;
}

/** Record an acquisition against an existing contact, in its own transaction. */
export async function recordAcquisition(
  context: CrmContext,
  input: InsertAcquisitionInput,
): Promise<string> {
  requireCapability(context, 'workspace:crm:contacts:write');

  return inTenant(context, async (tx, workspace) => {
    // Tenant-scoped: an acquisition cannot be attached to another tenant's
    // contact, because that contact is never loadable here.
    await loadInTenant(tx, contacts, workspace, input.contactId, [isNull(contacts.deletedAt)]);
    return insertAcquisition(context, tx, input);
  });
}

/**
 * Mark an acquisition as a qualified lead.
 *
 * This is the ONLY legitimate mutation of an acquisition row. Everything else
 * on it is immutable, enforced by the database trigger
 * `crm_acquisitions_provenance_immutable` — so even a future service that
 * tried to rewrite a source would be refused by PostgreSQL.
 */
export async function qualifyAcquisition(
  context: CrmContext,
  acquisitionId: string,
): Promise<void> {
  requireCapability(context, 'workspace:crm:contacts:write');

  await inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, acquisitions, workspace, acquisitionId);
    if (existing.qualifiedAt !== null) return; // Idempotent.

    const now = contextNow(context);
    await tx
      .update(acquisitions)
      .set({ qualifiedAt: now, qualifiedByUserId: actorUserId(context) })
      .where(and(eq(acquisitions.id, acquisitionId), tenantScope(acquisitions, workspace)));

    await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.ACQUISITION_QUALIFIED,
      summary: 'Lead qualified',
      contactId: existing.contactId,
      acquisitionId,
      occurredAt: now,
    });
  });
}

export async function listAcquisitionsForContact(
  context: CrmContext,
  contactId: string,
): Promise<readonly AcquisitionView[]> {
  requireCapability(context, 'workspace:crm:contacts:read');

  return inTenant(context, async (tx, workspace) => {
    await loadInTenant(tx, contacts, workspace, contactId, [isNull(contacts.deletedAt)]);

    const rows = await tx
      .select()
      .from(acquisitions)
      .where(and(tenantScope(acquisitions, workspace), eq(acquisitions.contactId, contactId)))
      .orderBy(asc(acquisitions.capturedAt));

    return rows.map((row): AcquisitionView => ({
      id: row.id,
      contactId: row.contactId,
      sourceType: row.sourceType,
      sourcePlatform: row.sourcePlatform,
      confidence: row.confidence,
      landingPath: row.landingPath,
      referrerOrigin: row.referrerOrigin,
      utmSource: row.utmSource,
      utmMedium: row.utmMedium,
      utmCampaign: row.utmCampaign,
      searchQuery: row.searchQuery,
      channelDetail: row.channelDetail,
      qualifiedAt: row.qualifiedAt?.toISOString() ?? null,
      capturedAt: row.capturedAt.toISOString(),
    }));
  });
}
