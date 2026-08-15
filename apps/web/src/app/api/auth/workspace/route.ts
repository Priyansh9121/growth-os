/**
 * POST /api/auth/workspace — switch the active workspace.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Demonstrates the tenancy authorization path end to end, and is the endpoint
 * the cross-tenant denial tests exercise.
 *
 * THE IMPORTANT PROPERTY
 * The request names a workspace. `requireWorkspaceAccess` decides whether the
 * caller may have it, from the actor's already-resolved membership graph — the
 * request never gets to assert access, only to ask for it. A user posting
 * another tenant's workspace ID receives 403 with a body that does not reveal
 * whether that workspace exists.
 *
 * Switching does NOT re-issue the session: a session identifies a user, not a
 * workspace (ADR-0005). The cookie set here is a preference that is
 * re-validated on every request.
 *
 * @see docs/architecture/multi-tenancy.md §6
 */

import { NextResponse } from 'next/server';
import { switchWorkspaceInputSchema, ValidationError } from '@growth-os/contracts';
import {
  requireWorkspaceAccess,
  WORKSPACE_COOKIE_NAME,
  workspaceCookieAttributes,
} from '@growth-os/auth';
import { AUDIT_EVENTS, withTenantTransaction, writeAuditEvent } from '@growth-os/database';
import { getDependencies } from '../../../../server/dependencies';
import { buildRequestContext, errorResponse, rejectUntrustedOrigin } from '../../../../server/http';
import { requireActor } from '../../../../server/auth-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);

  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { actor } = await requireActor();

    const body: unknown = await request.json().catch(() => null);
    const parsed = switchWorkspaceInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new ValidationError('Invalid workspace selection.');
    }

    // Authorization. Throws AuthorizationError → 403, with no indication of
    // whether the workspace exists.
    const tenant = requireWorkspaceAccess(actor, parsed.data.workspaceId, 'workspace:read');

    const deps = getDependencies();

    // The audit row is written INSIDE a tenant transaction, so it is subject
    // to the same RLS policy as every other tenant write. It would be easier
    // to write it unscoped; doing it properly here is what makes the pattern
    // the default for everything built later.
    await withTenantTransaction(deps.db, tenant.workspace.workspaceId, async (tx) => {
      await writeAuditEvent(
        deps.db,
        {
          workspaceId: tenant.workspace.workspaceId,
          actorUserId: actor.userId,
          eventName: AUDIT_EVENTS.TENANCY_WORKSPACE_SWITCHED,
          accessPath: tenant.workspace.via,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          correlationId: context.correlationId,
        },
        tx,
      );
    });

    const response = NextResponse.json(
      {
        ok: true,
        workspace: {
          workspaceId: tenant.workspace.workspaceId,
          workspaceName: tenant.workspace.workspaceName,
          role: tenant.workspace.role,
          via: tenant.workspace.via,
        },
      },
      { status: 200 },
    );

    response.cookies.set({
      name: WORKSPACE_COOKIE_NAME,
      value: tenant.workspace.workspaceId,
      ...workspaceCookieAttributes(deps.secureCookies, 60 * 60 * 24 * 365),
    });

    return response;
  } catch (error) {
    return errorResponse(error, context);
  }
}
