/**
 * /api/crm/custom-fields — define and list contact custom fields.
 *
 * A workspace's custom fields are its own schema, so creating one needs
 * `custom_fields:manage` (admin and owner). Reading the definitions needs only
 * `contacts:read`, because every operator has to render the form.
 */

import { type NextResponse } from 'next/server';
import { createCustomFieldSchema, ValidationError } from '@growth-os/contracts';
import { createCustomField, listCustomFields } from '@growth-os/crm';
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
    return jsonResponse({ fields: await listCustomFields(crm, includeArchived) }, context);
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
    const parsed = createCustomFieldSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the field details.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const crm = await requireCrmContext(context);
    return jsonResponse(await createCustomField(crm, parsed.data), context, 201);
  } catch (error) {
    return errorResponse(error, context);
  }
}
