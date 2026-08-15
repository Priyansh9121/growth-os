/**
 * Opportunity service — pipeline movement and commercial value.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Owns the deal lifecycle, and in particular `moveStage`, which is the
 * canonical example of an atomic multi-record operation in Growth OS:
 *
 *     validate → update stage + status → write activity → (caller: audit)
 *
 * all inside ONE transaction. A card that moved on the board without its
 * timeline entry, or a status that disagrees with its stage, is precisely the
 * inconsistency this shape prevents. The UI never writes the two separately.
 *
 * `status` mirrors the target stage's `category`, so reporting never depends
 * on a stage literally being named "Won" — a workspace may rename it to
 * "Job Booked" and win rate keeps working.
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 */

import { and, asc, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  ConflictError,
  NotFoundError,
  ValidationError,
  type CreateOpportunityInput,
  type MoveOpportunityStageInput,
  type OpportunityFilters,
  type OpportunityView,
  type Page,
  type UpdateOpportunityInput,
} from '@growth-os/contracts';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import { displayName } from '../identity/normalise';
import { decodeCursor, sliceToPage } from '../shared/pagination';
import {
  actorUserId,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type CrmContext,
} from '../shared/context';
import { recordActivity } from '../activities/service';

const { acquisitions, companies, contacts, opportunities, pipelines, pipelineStages, users } =
  schemaTables;

export async function createOpportunity(
  context: CrmContext,
  input: CreateOpportunityInput,
): Promise<OpportunityView> {
  requireCapability(context, 'workspace:crm:opportunities:write');

  return inTenant(context, async (tx, workspace) => {
    // Every referenced entity is loaded tenant-scoped, so a caller cannot
    // attach a deal to another workspace's contact, pipeline or stage.
    await loadInTenant(tx, contacts, workspace, input.contactId, [isNull(contacts.deletedAt)]);
    const pipeline = await loadInTenant(tx, pipelines, workspace, input.pipelineId);
    if (input.companyId) await loadInTenant(tx, companies, workspace, input.companyId);
    if (input.acquisitionId) await loadInTenant(tx, acquisitions, workspace, input.acquisitionId);

    const stage = input.stageId
      ? await loadInTenant(tx, pipelineStages, workspace, input.stageId)
      : await firstOpenStage(tx, workspace, input.pipelineId);

    if (stage.pipelineId !== input.pipelineId) {
      throw new ValidationError('That stage does not belong to the selected pipeline.');
    }

    const now = contextNow(context);
    const [row] = await tx
      .insert(opportunities)
      .values({
        workspaceId: workspace,
        title: input.title,
        contactId: input.contactId,
        companyId: input.companyId ?? null,
        pipelineId: input.pipelineId,
        stageId: stage.id,
        status: stage.category,
        ownerUserId: input.ownerUserId ?? actorUserId(context),
        estimatedValueMinor: input.estimatedValueMinor ?? 0,
        currency: input.currency ?? pipeline.currency,
        expectedCloseOn: input.expectedCloseOn ?? null,
        acquisitionId: input.acquisitionId ?? null,
        createdByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: opportunities.id });

    if (!row) throw new Error('Failed to insert opportunity');

    await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.OPPORTUNITY_CREATED,
      summary: `Opportunity created — ${input.title}`,
      contactId: input.contactId,
      opportunityId: row.id,
      occurredAt: now,
    });

    context.deps.events.publish({
      name: 'crm.opportunity.created',
      workspaceId: workspace,
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      actorType: 'user',
      actorUserId: actorUserId(context),
      opportunityId: row.id,
      contactId: input.contactId,
      pipelineId: input.pipelineId,
      stageId: stage.id,
      estimatedValueMinor: input.estimatedValueMinor ?? 0,
      currency: input.currency ?? pipeline.currency,
    });

    return projectOpportunity(tx, workspace, row.id);
  });
}

async function firstOpenStage(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  pipelineId: string,
) {
  const [stage] = await tx
    .select()
    .from(pipelineStages)
    .where(
      and(
        tenantScope(pipelineStages, workspace),
        eq(pipelineStages.pipelineId, pipelineId),
        eq(pipelineStages.category, 'open'),
        isNull(pipelineStages.archivedAt),
      ),
    )
    .orderBy(asc(pipelineStages.position))
    .limit(1);

  if (!stage) throw new ValidationError('That pipeline has no open stage to place a deal in.');
  return stage;
}

/**
 * Move an opportunity to a different stage.
 *
 * ATOMIC BY CONSTRUCTION. Stage, status, closed-at and the timeline entry all
 * change together or not at all.
 *
 * `expectedCurrentStageId` provides optimistic concurrency: two operators
 * dragging the same card should not silently overwrite one another. The second
 * receives a `ConflictError` rather than winning by arriving last.
 */
export async function moveOpportunityStage(
  context: CrmContext,
  opportunityId: string,
  input: MoveOpportunityStageInput,
): Promise<OpportunityView> {
  requireCapability(context, 'workspace:crm:opportunities:write');

  return inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, opportunities, workspace, opportunityId);
    const targetStage = await loadInTenant(tx, pipelineStages, workspace, input.stageId);

    if (targetStage.pipelineId !== existing.pipelineId) {
      throw new ValidationError('That stage belongs to a different pipeline.');
    }
    if (targetStage.archivedAt !== null) {
      throw new ValidationError('That stage has been archived.');
    }

    if (
      input.expectedCurrentStageId !== undefined &&
      input.expectedCurrentStageId !== existing.stageId
    ) {
      throw new ConflictError(
        `Opportunity ${opportunityId} moved concurrently`,
        'Someone else moved this deal. Refresh to see where it is now.',
      );
    }

    if (existing.stageId === targetStage.id) {
      return projectOpportunity(tx, workspace, opportunityId);
    }

    const [fromStage] = await tx
      .select({ name: pipelineStages.name })
      .from(pipelineStages)
      .where(eq(pipelineStages.id, existing.stageId))
      .limit(1);

    const now = contextNow(context);
    const isTerminal = targetStage.category !== 'open';

    await tx
      .update(opportunities)
      .set({
        stageId: targetStage.id,
        // Status follows the stage's CATEGORY, never its name.
        status: targetStage.category,
        closedAt: isTerminal ? now : null,
        updatedAt: now,
      })
      .where(and(eq(opportunities.id, opportunityId), tenantScope(opportunities, workspace)));

    const activityType =
      targetStage.category === 'won'
        ? ACTIVITY_TYPES.OPPORTUNITY_WON
        : targetStage.category === 'lost'
          ? ACTIVITY_TYPES.OPPORTUNITY_LOST
          : ACTIVITY_TYPES.OPPORTUNITY_STAGE_CHANGED;

    await recordActivity(context, tx, {
      type: activityType,
      summary: `${fromStage?.name ?? 'Unknown'} → ${targetStage.name}`,
      contactId: existing.contactId,
      opportunityId,
      occurredAt: now,
    });

    context.deps.events.publish({
      name: 'crm.opportunity.stage_changed',
      workspaceId: workspace,
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      actorType: 'user',
      actorUserId: actorUserId(context),
      opportunityId,
      fromStageId: existing.stageId,
      toStageId: targetStage.id,
      status: targetStage.category,
    });

    return projectOpportunity(tx, workspace, opportunityId);
  });
}

export async function updateOpportunity(
  context: CrmContext,
  opportunityId: string,
  input: UpdateOpportunityInput,
): Promise<OpportunityView> {
  requireCapability(context, 'workspace:crm:opportunities:write');

  return inTenant(context, async (tx, workspace) => {
    await loadInTenant(tx, opportunities, workspace, opportunityId);

    const changes: Record<string, unknown> = { updatedAt: contextNow(context) };
    if (input.title !== undefined) changes['title'] = input.title;
    if (input.ownerUserId !== undefined) changes['ownerUserId'] = input.ownerUserId;
    if (input.estimatedValueMinor !== undefined) {
      changes['estimatedValueMinor'] = input.estimatedValueMinor;
    }
    if (input.expectedCloseOn !== undefined) changes['expectedCloseOn'] = input.expectedCloseOn;

    await tx
      .update(opportunities)
      .set(changes)
      .where(and(eq(opportunities.id, opportunityId), tenantScope(opportunities, workspace)));

    return projectOpportunity(tx, workspace, opportunityId);
  });
}

export async function listOpportunities(
  context: CrmContext,
  filters: OpportunityFilters,
): Promise<Page<OpportunityView>> {
  requireCapability(context, 'workspace:crm:opportunities:read');

  const cursor = decodeCursor(filters.cursor);

  return inTenant(context, async (tx, workspace) => {
    const conditions: SQL[] = [tenantScope(opportunities, workspace)];

    if (filters.pipelineId) conditions.push(eq(opportunities.pipelineId, filters.pipelineId));
    if (filters.stageId) conditions.push(eq(opportunities.stageId, filters.stageId));
    if (filters.ownerUserId) conditions.push(eq(opportunities.ownerUserId, filters.ownerUserId));
    if (filters.status) conditions.push(eq(opportunities.status, filters.status));

    if (cursor) {
      const value = new Date(cursor.value);
      const keyset = or(
        lt(opportunities.createdAt, value),
        and(eq(opportunities.createdAt, value), lt(opportunities.id, cursor.id)),
      );
      if (keyset) conditions.push(keyset);
    }

    const rows = await tx
      .select(opportunitySelection())
      .from(opportunities)
      .innerJoin(contacts, eq(contacts.id, opportunities.contactId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .leftJoin(companies, eq(companies.id, opportunities.companyId))
      .leftJoin(users, eq(users.id, opportunities.ownerUserId))
      .leftJoin(acquisitions, eq(acquisitions.id, opportunities.acquisitionId))
      .where(and(...conditions))
      .orderBy(desc(opportunities.createdAt), desc(opportunities.id))
      .limit(filters.limit + 1);

    const page = sliceToPage(rows, filters.limit, (row) => row.createdAt.toISOString());
    return { items: page.items.map(toOpportunityView), nextCursor: page.nextCursor };
  });
}

function opportunitySelection() {
  return {
    id: opportunities.id,
    title: opportunities.title,
    contactId: opportunities.contactId,
    contactFirstName: contacts.firstName,
    contactLastName: contacts.lastName,
    companyId: opportunities.companyId,
    companyName: companies.name,
    pipelineId: opportunities.pipelineId,
    stageId: opportunities.stageId,
    stageName: pipelineStages.name,
    stageCategory: pipelineStages.category,
    status: opportunities.status,
    ownerUserId: opportunities.ownerUserId,
    ownerName: users.name,
    estimatedValueMinor: opportunities.estimatedValueMinor,
    currency: opportunities.currency,
    expectedCloseOn: opportunities.expectedCloseOn,
    sourceType: acquisitions.sourceType,
    createdAt: opportunities.createdAt,
    closedAt: opportunities.closedAt,
  };
}

type OpportunityRowShape = {
  [K in keyof ReturnType<typeof opportunitySelection>]: unknown;
} & {
  id: string;
  title: string;
  contactId: string;
  contactFirstName: string;
  contactLastName: string | null;
  createdAt: Date;
};

function toOpportunityView(row: OpportunityRowShape): OpportunityView {
  return {
    id: row.id,
    title: row.title,
    contactId: row.contactId,
    contactName: displayName(row.contactFirstName, row.contactLastName),
    companyId: row.companyId as string | null,
    companyName: row.companyName as string | null,
    pipelineId: row.pipelineId as string,
    stageId: row.stageId as string,
    stageName: row.stageName as string,
    stageCategory: row.stageCategory as OpportunityView['stageCategory'],
    status: row.status as OpportunityView['status'],
    ownerUserId: row.ownerUserId as string | null,
    ownerName: row.ownerName as string | null,
    estimatedValueMinor: Number(row.estimatedValueMinor),
    currency: row.currency as OpportunityView['currency'],
    expectedCloseOn: (row.expectedCloseOn as string | null) ?? null,
    sourceType: (row.sourceType as OpportunityView['sourceType']) ?? null,
    createdAt: row.createdAt.toISOString(),
    closedAt: (row.closedAt as Date | null)?.toISOString() ?? null,
  };
}

async function projectOpportunity(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  opportunityId: string,
): Promise<OpportunityView> {
  const [row] = await tx
    .select(opportunitySelection())
    .from(opportunities)
    .innerJoin(contacts, eq(contacts.id, opportunities.contactId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(companies, eq(companies.id, opportunities.companyId))
    .leftJoin(users, eq(users.id, opportunities.ownerUserId))
    .leftJoin(acquisitions, eq(acquisitions.id, opportunities.acquisitionId))
    .where(and(eq(opportunities.id, opportunityId), tenantScope(opportunities, workspace)))
    .limit(1);

  if (!row) throw new NotFoundError(`Opportunity ${opportunityId} not found`);
  return toOpportunityView(row);
}

/**
 * Aggregate open value and count per stage. Powers the Kanban column headers.
 *
 * ⚠️ TAKES A TRANSACTION, DELIBERATELY.
 *
 * An earlier version opened its own transaction via `inTenant`. Because it is
 * called from inside `getPipelineInTransaction`, that produced a NESTED
 * transaction: postgres.js took a second connection from the pool, which could
 * not see the outer transaction's uncommitted rows — and, with a small pool,
 * deadlocked outright. The seed script hung on it.
 *
 * The rule this encodes: **a function that may be called from within a
 * transaction must accept that transaction rather than opening its own.**
 * Making `tx` a required parameter puts the rule in the type system instead of
 * in a comment nobody reads.
 */
export async function stageTotalsInTransaction(
  tx: TenantTransaction,
  workspace: string,
  pipelineId: string,
): Promise<Map<string, { count: number; valueMinor: number }>> {
  const totals = new Map<string, { count: number; valueMinor: number }>();

  const rows = await tx
    .select({
      stageId: opportunities.stageId,
      count: sql<number>`count(*)::int`,
      value: sql<string>`coalesce(sum(${opportunities.estimatedValueMinor}), 0)`,
    })
    .from(opportunities)
    .where(and(tenantScope(opportunities, workspace), eq(opportunities.pipelineId, pipelineId)))
    .groupBy(opportunities.stageId);

  for (const row of rows) {
    totals.set(row.stageId, { count: row.count, valueMinor: Number(row.value) });
  }

  return totals;
}

/** Public wrapper for callers that are NOT already inside a transaction. */
export async function pipelineStageTotals(
  context: CrmContext,
  pipelineId: string,
): Promise<Map<string, { count: number; valueMinor: number }>> {
  return inTenant(context, (tx, workspace) => stageTotalsInTransaction(tx, workspace, pipelineId));
}
