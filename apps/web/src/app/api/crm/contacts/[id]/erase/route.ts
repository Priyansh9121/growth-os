/**
 * /api/crm/contacts/:id/erase — preview and execute erasure.
 *
 * GET previews what would be cleared AND what would survive. The second half
 * matters: the most common misunderstanding of "erase this customer" is that
 * it deletes the sale, and an operator who believes that will avoid using a
 * feature they are obliged to use.
 *
 * POST requires the confirmation phrase in the body. That is not a security
 * control — anyone who can reach this endpoint can type it — but it forces the
 * operator to read the sentence above it before doing something with no undo.
 *
 * DELETE is deliberately NOT the verb. `DELETE /contacts/:id` already means
 * archive, and having two DELETEs on nearly the same URL with catastrophically
 * different meanings is how the wrong one gets called.
 *
 * @see docs/decisions/ADR-0020-privacy-erasure.md
 */

import { type NextResponse } from 'next/server';
import { eraseContactSchema, ValidationError } from '@growth-os/contracts';
import { eraseContact, previewErasure } from '@growth-os/crm';
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
    return jsonResponse(await previewErasure(crm, id), context);
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

    const parsed = eraseContactSchema.safeParse({
      ...(typeof body === 'object' && body !== null ? body : {}),
      contactId: id,
    });

    if (!parsed.success) {
      throw new ValidationError(
        'Confirmation is required to erase a contact.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const crm = await requireCrmContext(context);
    return jsonResponse(await eraseContact(crm, id), context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
