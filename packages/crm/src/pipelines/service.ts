/**
 * Pipeline configuration service.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Pipelines and their ordered stages are workspace-owned CONFIGURATION, not
 * global product behaviour. The default template below is a seeded starting
 * point that any workspace may replace — a plumbing business and a law firm do
 * not share a sales process.
 *
 * Stages carry a `category` (open/won/lost) separate from their name so that
 * reporting never depends on a stage literally being called "Won".
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  NotFoundError,
  ValidationError,
  type CreatePipelineInput,
  type PipelineView,
  type StageCategory,
} from '@growth-os/contracts';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import {
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type CrmContext,
} from '../shared/context';
import { stageTotalsInTransaction } from '../opportunities/service';

const { pipelines, pipelineStages } = schemaTables;

/**
 * The default sales pipeline offered to a new workspace.
 *
 * A FIXTURE, not a hardcoded business rule: it is applied at workspace
 * creation and is fully editable afterwards. Kept here rather than in the seed
 * script so that future self-serve onboarding uses the same template.
 */
export const DEFAULT_PIPELINE_TEMPLATE: {
  name: string;
  stages: readonly { name: string; category: StageCategory }[];
} = {
  name: 'Sales Pipeline',
  stages: [
    { name: 'New Lead', category: 'open' },
    { name: 'Contacted', category: 'open' },
    { name: 'Qualified', category: 'open' },
    { name: 'Appointment', category: 'open' },
    { name: 'Quote', category: 'open' },
    { name: 'Won', category: 'won' },
    { name: 'Lost', category: 'lost' },
  ],
};

/**
 * Create a pipeline and its stages atomically.
 *
 * Stage positions are spaced by 10 so a stage can later be inserted between
 * two others without renumbering every row — a small choice that avoids a
 * whole-table update on every reorder.
 */
export async function createPipeline(
  context: CrmContext,
  input: CreatePipelineInput,
  options: { isDefault?: boolean } = {},
): Promise<PipelineView> {
  requireCapability(context, 'workspace:crm:pipelines:manage');

  return inTenant(context, async (tx, workspace) => {
    const now = contextNow(context);
    const [pipeline] = await tx
      .insert(pipelines)
      .values({
        workspaceId: workspace,
        name: input.name,
        isDefault: options.isDefault ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: pipelines.id });

    if (!pipeline) throw new Error('Failed to insert pipeline');

    await tx.insert(pipelineStages).values(
      input.stages.map((stage, index) => ({
        workspaceId: workspace,
        pipelineId: pipeline.id,
        name: stage.name,
        category: stage.category,
        position: (index + 1) * 10,
        createdAt: now,
        updatedAt: now,
      })),
    );

    return getPipelineInTransaction(tx, workspace, pipeline.id);
  });
}

/** Provision the default pipeline. Used by seeding and future onboarding. */
export async function ensureDefaultPipeline(context: CrmContext): Promise<PipelineView> {
  const existing = await findDefaultPipeline(context);
  if (existing) return existing;

  return createPipeline(
    context,
    { name: DEFAULT_PIPELINE_TEMPLATE.name, stages: [...DEFAULT_PIPELINE_TEMPLATE.stages] },
    { isDefault: true },
  );
}

export async function findDefaultPipeline(context: CrmContext): Promise<PipelineView | null> {
  requireCapability(context, 'workspace:crm:opportunities:read');

  return inTenant(context, async (tx, workspace) => {
    const [row] = await tx
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(
        and(
          tenantScope(pipelines, workspace),
          eq(pipelines.isDefault, true),
          isNull(pipelines.archivedAt),
        ),
      )
      .limit(1);

    if (!row) return null;
    return getPipelineInTransaction(tx, workspace, row.id);
  });
}

export async function getPipeline(context: CrmContext, pipelineId: string): Promise<PipelineView> {
  requireCapability(context, 'workspace:crm:opportunities:read');

  return inTenant(context, async (tx, workspace) => {
    await loadInTenant(tx, pipelines, workspace, pipelineId);
    return getPipelineInTransaction(tx, workspace, pipelineId);
  });
}

export async function listPipelines(context: CrmContext): Promise<readonly PipelineView[]> {
  requireCapability(context, 'workspace:crm:opportunities:read');

  return inTenant(context, async (tx, workspace) => {
    const rows = await tx
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(tenantScope(pipelines, workspace), isNull(pipelines.archivedAt)))
      .orderBy(asc(pipelines.createdAt));

    const views: PipelineView[] = [];
    for (const row of rows) {
      views.push(await getPipelineInTransaction(tx, workspace, row.id));
    }
    return views;
  });
}

async function getPipelineInTransaction(
  tx: TenantTransaction,
  workspace: string,
  pipelineId: string,
): Promise<PipelineView> {
  const [pipeline] = await tx
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), tenantScope(pipelines, workspace)))
    .limit(1);

  if (!pipeline) throw new NotFoundError(`Pipeline ${pipelineId} not found`);

  const stages = await tx
    .select()
    .from(pipelineStages)
    .where(
      and(
        tenantScope(pipelineStages, workspace),
        eq(pipelineStages.pipelineId, pipelineId),
        isNull(pipelineStages.archivedAt),
      ),
    )
    .orderBy(asc(pipelineStages.position));

  // Reuses the CALLER'S transaction — opening a nested one would take a
  // second pooled connection that cannot see uncommitted rows, and can
  // deadlock. See stageTotalsInTransaction.
  const totals = await stageTotalsInTransaction(tx, workspace, pipelineId);

  return {
    id: pipeline.id,
    name: pipeline.name,
    isDefault: pipeline.isDefault,
    currency: pipeline.currency,
    stages: stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      position: stage.position,
      category: stage.category,
      openOpportunityCount: totals.get(stage.id)?.count ?? 0,
      openValueMinor: totals.get(stage.id)?.valueMinor ?? 0,
    })),
  };
}

/**
 * Archive a stage.
 *
 * Refuses while opportunities still occupy it — archiving would strand them in
 * a state the board no longer renders. Archive, never delete: the FK from
 * `opportunities.stage_id` is `ON DELETE restrict` for the same reason.
 */
export async function archiveStage(context: CrmContext, stageId: string): Promise<void> {
  requireCapability(context, 'workspace:crm:pipelines:manage');

  await inTenant(context, async (tx, workspace) => {
    const stage = await loadInTenant(tx, pipelineStages, workspace, stageId);

    const { opportunities } = schemaTables;
    const [occupied] = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(tenantScope(opportunities, workspace), eq(opportunities.stageId, stageId)))
      .limit(1);

    if (occupied) {
      throw new ValidationError('Move the deals out of this stage before archiving it.');
    }

    await tx
      .update(pipelineStages)
      .set({ archivedAt: contextNow(context), updatedAt: contextNow(context) })
      .where(and(eq(pipelineStages.id, stage.id), tenantScope(pipelineStages, workspace)));
  });
}
