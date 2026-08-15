/**
 * /api/crm/tags — the workspace's tag vocabulary.
 *
 * Listing needs only `contacts:read` (every operator picks from the list);
 * creating needs `tags:manage`, which `member` does not hold. The service
 * enforces both — this file only parses and delegates.
 */

import { type NextResponse } from 'next/server';
import { createTagSchema, ValidationError } from '@growth-os/contracts';
import { createTag, listTags } from '@growth-os/crm';
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
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
    const crm = await requireCrmContext(context);
    return jsonResponse({ tags: await listTags(crm, includeArchived) }, context);
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
    const parsed = createTagSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the tag details.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const crm = await requireCrmContext(context);
    return jsonResponse(await createTag(crm, parsed.data), context, 201);
  } catch (error) {
    return errorResponse(error, context);
  }
}
