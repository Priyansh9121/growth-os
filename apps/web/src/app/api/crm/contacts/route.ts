/**
 * /api/crm/contacts — list and create.
 *
 * A thin transport adapter. All business logic, authorization and tenancy live
 * in `@growth-os/crm`; this file parses, delegates and serialises. That is what
 * keeps the same logic reusable by the worker (Stage 3) and the voice service
 * (Stage 13) without a Next.js dependency.
 */

import { type NextResponse } from 'next/server';
import { contactFiltersSchema, createContactSchema, ValidationError } from '@growth-os/contracts';
import { createContact, listContacts } from '@growth-os/crm';
import { AUDIT_EVENTS, writeAuditEvent } from '@growth-os/database';
import { getDependencies } from '../../../../server/dependencies';
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
    const url = new URL(request.url);
    // A closed set of named filters — never a generic query language, which
    // would let a client name arbitrary columns (ADR-0016 §2).
    const parsed = contactFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid filters.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const crm = await requireCrmContext(context);
    return jsonResponse(await listContacts(crm, parsed.data), context);
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
    const parsed = createContactSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the details you entered.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const crm = await requireCrmContext(context);
    const result = await createContact(crm, parsed.data);

    // Audit alongside the activity the service already wrote. Two records,
    // two audiences (ADR-0014). Identifiers only — never the contact's details.
    await writeAuditEvent(getDependencies().db, {
      workspaceId: crm.tenant.workspace.workspaceId,
      actorUserId: crm.tenant.actor.userId,
      eventName: AUDIT_EVENTS.CRM_CONTACT_CREATED,
      accessPath: crm.tenant.workspace.via,
      targetType: 'contact',
      targetId: result.contact.id,
      correlationId: context.correlationId,
    });

    return jsonResponse(result, context, 201);
  } catch (error) {
    return errorResponse(error, context);
  }
}
