/**
 * /api/crm/contacts/:id/tags — apply and remove.
 *
 * DELETE takes the tag id in the query string rather than a nested path
 * segment, because removing a tag assignment is not deleting a resource that
 * has its own URL — the assignment is a property of the pairing.
 */

import { type NextResponse } from 'next/server';
import { applyTagSchema, ValidationError } from '@growth-os/contracts';
import { applyTag, listContactTags, removeTag } from '@growth-os/crm';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../../../server/http';
import { requireCrmContext } from '../../../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const { id } = await params;
    const crm = await requireCrmContext(context);
    return jsonResponse({ tags: await listContactTags(crm, id) }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = applyTagSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Name the tag to apply.');

    const crm = await requireCrmContext(context);
    return jsonResponse({ tags: await applyTag(crm, id, parsed.data.tagId) }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { id } = await params;
    const tagId = new URL(request.url).searchParams.get('tagId');
    if (!tagId) throw new ValidationError('Name the tag to remove.');

    const crm = await requireCrmContext(context);
    return jsonResponse({ tags: await removeTag(crm, id, tagId) }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
