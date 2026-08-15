/** GET /api/crm/pipelines — pipelines with stages and live aggregates. */
import { type NextResponse } from 'next/server';
import { listPipelines } from '@growth-os/crm';
import { buildRequestContext, errorResponse, jsonResponse } from '../../../../server/http';
import { requireCrmContext } from '../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const crm = await requireCrmContext(context);
    return jsonResponse({ pipelines: await listPipelines(crm) }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
