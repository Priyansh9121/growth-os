/**
 * /api/crm/contacts/:id/merge — preview and execute a merge.
 *
 * GET previews. POST merges. That split is the whole safety model: there is no
 * undo, so the only protection is that an operator can see the exact blast
 * radius first, and that executing it requires a separate, explicit request
 * carrying `confirm: true`.
 *
 * `:id` is the SURVIVOR — the record that keeps working afterwards. The
 * duplicate is named in the query string or body. Putting the survivor in the
 * path means a mistyped URL cannot silently reverse the direction of a merge.
 *
 * @see docs/decisions/ADR-0019-contact-merge.md
 */

import { type NextResponse } from 'next/server';
import { mergeContactsSchema, ValidationError } from '@growth-os/contracts';
import { mergeContacts, previewMerge } from '@growth-os/crm';
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
    const duplicateId = new URL(request.url).searchParams.get('duplicateId');
    if (!duplicateId) {
      throw new ValidationError('Name the duplicate record to preview.');
    }

    const crm = await requireCrmContext(context);
    return jsonResponse(await previewMerge(crm, id, duplicateId), context);
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

    // The path is authoritative for the survivor. A body that disagreed would
    // make the URL a lie, and the URL is what appears in logs and audit records.
    const parsed = mergeContactsSchema.safeParse({
      ...(typeof body === 'object' && body !== null ? body : {}),
      survivorId: id,
    });

    if (!parsed.success) {
      throw new ValidationError(
        'Check the merge details.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const crm = await requireCrmContext(context);
    // The service writes both the audit record and the timeline entry inside
    // its own transaction, so this route deliberately does not add one after
    // the fact — a second, later write could succeed or fail independently.
    return jsonResponse(await mergeContacts(crm, parsed.data), context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
