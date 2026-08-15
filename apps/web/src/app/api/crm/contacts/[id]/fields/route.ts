/**
 * /api/crm/contacts/:id/fields — read and set custom field values.
 *
 * Values ride on `contacts:write` rather than a capability of their own. A
 * separate one would invite a workspace where someone can edit a contact's
 * email but not their "Property Type" — which nobody wants, and nobody would
 * notice was wrong.
 */

import { type NextResponse } from 'next/server';
import { setCustomFieldValueSchema, ValidationError } from '@growth-os/contracts';
import { listCustomFieldValues, setCustomFieldValue } from '@growth-os/crm';
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
    return jsonResponse({ values: await listCustomFieldValues(crm, id) }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

export async function PUT(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = setCustomFieldValueSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the value.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const crm = await requireCrmContext(context);
    // The response is every value for the contact, not just the one written:
    // a form that re-renders from the server's answer cannot drift from it.
    return jsonResponse({ values: await setCustomFieldValue(crm, id, parsed.data) }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
