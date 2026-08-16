/**
 * /api/crm/forms/:id — read, update, publish, pause, rotate the key.
 *
 * IDOR DEFENCE: the id goes to a tenant-scoped service that resolves it
 * THROUGH the workspace. A form belonging to another workspace produces 404,
 * never 403 — the response cannot confirm it exists somewhere.
 */

import { type NextResponse } from 'next/server';
import { updateFormSchema, ValidationError } from '@growth-os/contracts';
import { getForm, rotatePublicKey, updateForm } from '@growth-os/forms';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../../server/http';
import { requireAuthContext } from '../../../../../server/auth-context';
import { buildFormsContext } from '../../../../../server/forms/dependencies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const { id } = await params;
    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');
    const form = await getForm(buildFormsContext(actor, workspace, context.correlationId), id);
    return jsonResponse(form, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);

    // Key rotation is a flag on the update rather than its own endpoint: it is
    // rare, destructive to existing embeds, and belongs beside the settings it
    // invalidates rather than hidden behind a URL nobody reads.
    if (typeof body === 'object' && body !== null && 'rotateKey' in body) {
      const { actor, workspace } = await requireAuthContext();
      if (!workspace) throw new ValidationError('No workspace selected.');
      const rotated = await rotatePublicKey(
        buildFormsContext(actor, workspace, context.correlationId),
        id,
      );
      return jsonResponse(rotated, context);
    }

    const parsed = updateFormSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the form configuration.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');

    const form = await updateForm(
      buildFormsContext(actor, workspace, context.correlationId),
      id,
      parsed.data,
    );
    return jsonResponse(form, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
