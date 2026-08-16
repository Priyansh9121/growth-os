/**
 * /api/crm/forms — list and create.
 *
 * A thin transport adapter, like every other authenticated route. Publishing
 * is a status change through PATCH on `[id]`, not a separate verb: publish,
 * pause and rename are all "the configuration changed", and modelling publish
 * as its own endpoint would invite a second code path that skips the
 * publishability checks.
 */

import { type NextResponse } from 'next/server';
import { createFormSchema, ValidationError } from '@growth-os/contracts';
import { createForm, listForms } from '@growth-os/forms';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../server/http';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildFormsContext } from '../../../../server/forms/dependencies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');
    const forms = await listForms(buildFormsContext(actor, workspace, context.correlationId));
    return jsonResponse({ forms }, context);
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
    const parsed = createFormSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the form details.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');

    const form = await createForm(
      buildFormsContext(actor, workspace, context.correlationId),
      parsed.data,
    );
    return jsonResponse(form, context, 201);
  } catch (error) {
    return errorResponse(error, context);
  }
}
