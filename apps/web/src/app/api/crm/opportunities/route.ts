/** /api/crm/opportunities — list and create. */
import { type NextResponse } from 'next/server';
import {
  createOpportunitySchema,
  opportunityFiltersSchema,
  ValidationError,
} from '@growth-os/contracts';
import { createOpportunity, listOpportunities } from '@growth-os/crm';
import { AUDIT_EVENTS, writeAuditEvent } from '@growth-os/database';
import { getDependencies } from '../../../../server/dependencies';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../server/http';
import { requireCrmContext } from '../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const url = new URL(request.url);
    const parsed = opportunityFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new ValidationError('Invalid filters.');
    const crm = await requireCrmContext(context);
    return jsonResponse(await listOpportunities(crm, parsed.data), context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const body: unknown = await request.json().catch(() => null);
    const parsed = createOpportunitySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the details you entered.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const crm = await requireCrmContext(context);
    const opportunity = await createOpportunity(crm, parsed.data);

    await writeAuditEvent(getDependencies().db, {
      workspaceId: crm.tenant.workspace.workspaceId,
      actorUserId: crm.tenant.actor.userId,
      eventName: AUDIT_EVENTS.CRM_OPPORTUNITY_CREATED,
      accessPath: crm.tenant.workspace.via,
      targetType: 'opportunity',
      targetId: opportunity.id,
      correlationId: context.correlationId,
    });

    return jsonResponse(opportunity, context, 201);
  } catch (error) {
    return errorResponse(error, context);
  }
}
