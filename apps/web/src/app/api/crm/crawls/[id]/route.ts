/**
 * GET /api/crm/crawls/:id — what one crawl did.
 *
 * ⚠️ FACTS, NOT FINDINGS (§5). Statuses, counts and typed outcomes. "Your
 * robots.txt is misconfigured" is Stage 5's sentence to write from these
 * values, and writing it here would bury the judgement in the collection layer
 * where changing it means recrawling every customer's website.
 *
 * Tenant-scoped by the service: a crawl id from another workspace is not found
 * rather than refused, so the response cannot confirm the row exists.
 */

import { type NextResponse } from 'next/server';
import { ValidationError } from '@growth-os/contracts';
import { getCrawl } from '@growth-os/sites';
import { buildRequestContext, errorResponse, jsonResponse } from '../../../../../server/http';
import { requireAuthContext } from '../../../../../server/auth-context';
import { buildFormsContext } from '../../../../../server/forms/dependencies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const { id } = await params;
    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');

    const crawl = await getCrawl(buildFormsContext(actor, workspace, context.correlationId), id);
    return jsonResponse(crawl, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
