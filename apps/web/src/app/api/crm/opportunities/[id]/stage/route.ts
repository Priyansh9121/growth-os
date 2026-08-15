/**
 * PATCH /api/crm/opportunities/:id/stage — move a deal.
 *
 * A dedicated endpoint rather than a general PATCH, because moving stage is
 * not a field edit: it changes status, may close the deal, writes a timeline
 * entry and emits a domain event — all in one transaction inside the service.
 *
 * NO OPTIMISTIC LIES: the UI awaits this response before the card settles in
 * its new column. `expectedCurrentStageId` provides optimistic concurrency, so
 * two operators dragging the same card produce a 409 rather than a silent
 * last-writer-wins overwrite.
 */
import { type NextResponse } from 'next/server';
import { moveOpportunityStageSchema, ValidationError } from '@growth-os/contracts';
import { moveOpportunityStage } from '@growth-os/crm';
import { AUDIT_EVENTS, writeAuditEvent } from '@growth-os/database';
import { getDependencies } from '../../../../../../server/dependencies';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../../../server/http';
import { requireCrmContext } from '../../../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = moveOpportunityStageSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid stage change.');

    const crm = await requireCrmContext(context);
    const opportunity = await moveOpportunityStage(crm, id, parsed.data);

    await writeAuditEvent(getDependencies().db, {
      workspaceId: crm.tenant.workspace.workspaceId,
      actorUserId: crm.tenant.actor.userId,
      eventName: AUDIT_EVENTS.CRM_OPPORTUNITY_STAGE_CHANGED,
      accessPath: crm.tenant.workspace.via,
      targetType: 'opportunity',
      targetId: id,
      correlationId: context.correlationId,
      metadata: { toStageId: parsed.data.stageId, status: opportunity.status },
    });

    return jsonResponse(opportunity, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
