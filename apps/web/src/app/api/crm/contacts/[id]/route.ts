/**
 * /api/crm/contacts/:id — read, update, archive.
 *
 * IDOR DEFENCE: the id is passed to a tenant-scoped service that resolves it
 * THROUGH the workspace. There is no "fetch then check ownership" step here,
 * because `@growth-os/crm` exposes no function that would allow one.
 *
 * A record belonging to another workspace produces 404 — never 403 — so the
 * response cannot confirm that another tenant holds a record with that id.
 */

import { type NextResponse } from 'next/server';
import { updateContactSchema, ValidationError } from '@growth-os/contracts';
import { archiveContact, getContact, updateContact } from '@growth-os/crm';
import { AUDIT_EVENTS, writeAuditEvent } from '@growth-os/database';
import { getDependencies } from '../../../../../server/dependencies';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../../server/http';
import { requireCrmContext } from '../../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const { id } = await params;
    const crm = await requireCrmContext(context);
    return jsonResponse(await getContact(crm, id), context);
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
    const parsed = updateContactSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the details you entered.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const crm = await requireCrmContext(context);
    const contact = await updateContact(crm, id, parsed.data);

    await writeAuditEvent(getDependencies().db, {
      workspaceId: crm.tenant.workspace.workspaceId,
      actorUserId: crm.tenant.actor.userId,
      eventName: AUDIT_EVENTS.CRM_CONTACT_UPDATED,
      accessPath: crm.tenant.workspace.via,
      targetType: 'contact',
      targetId: id,
      correlationId: context.correlationId,
      // Field names only. The values are PII and belong in the timeline, not
      // in the security log (ADR-0014).
      metadata: { fields: Object.keys(parsed.data) },
    });

    return jsonResponse(contact, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

/**
 * Archive, not delete.
 *
 * DELETE is the honest HTTP verb for the user's intent ("remove this from my
 * list"), but the effect is a soft delete: identity records stay recoverable
 * and their history stays intact (ADR-0013). Requires `contacts:archive`,
 * which `member` does not hold.
 */
export async function DELETE(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { id } = await params;
    const crm = await requireCrmContext(context);
    await archiveContact(crm, id);

    await writeAuditEvent(getDependencies().db, {
      workspaceId: crm.tenant.workspace.workspaceId,
      actorUserId: crm.tenant.actor.userId,
      eventName: AUDIT_EVENTS.CRM_CONTACT_ARCHIVED,
      accessPath: crm.tenant.workspace.via,
      targetType: 'contact',
      targetId: id,
      correlationId: context.correlationId,
    });

    return jsonResponse({ ok: true, archived: true }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
