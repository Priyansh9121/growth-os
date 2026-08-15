import 'server-only';

/**
 * Bridge from an HTTP request to a `CrmContext`.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single place where an authenticated request becomes an authorized CRM
 * caller. It performs, in order:
 *
 *   1. session validation      (`requireActor`)
 *   2. workspace authorization (`requireWorkspaceAccess` → `TenantActor`)
 *   3. context construction
 *
 * Only step 2 produces a `TenantActor`, and every CRM service demands one, so
 * a route handler cannot reach the CRM without having passed authorization.
 * The insecure ordering — query first, check ownership afterwards — is not
 * expressible through this path.
 *
 * @see packages/crm/src/shared/context.ts
 */

import { requireWorkspaceAccess } from '@growth-os/auth';
import { AuthorizationError, type Capability } from '@growth-os/contracts';
import { InProcessEventPublisher, type CrmContext } from '@growth-os/crm';
import { getDependencies } from './dependencies';
import { requireActor } from './auth-context';
import type { RequestContext } from './http';

/**
 * Process-wide event publisher.
 *
 * A singleton for correctness, not efficiency: subscribers register against a
 * specific instance, so a fresh publisher per request would deliver to nobody.
 */
let publisher: InProcessEventPublisher | null = null;

export function getEventPublisher(): InProcessEventPublisher {
  publisher ??= new InProcessEventPublisher();
  return publisher;
}

/**
 * Resolve the CRM context for a request.
 *
 * @param workspaceIdOverride Explicit workspace, e.g. from a request body.
 *   Always re-validated against the actor's memberships — a client-supplied
 *   workspace is a request, never a grant.
 * @throws AuthenticationError when unauthenticated.
 * @throws AuthorizationError when the workspace is not accessible.
 */
export async function requireCrmContext(
  request: RequestContext,
  workspaceIdOverride?: string | undefined,
): Promise<CrmContext> {
  const { actor, workspace } = await requireActor();

  const targetWorkspaceId = workspaceIdOverride ?? workspace?.workspaceId;
  if (!targetWorkspaceId) {
    throw new AuthorizationError('No workspace is available for this user', {
      details: { userId: actor.userId },
    });
  }

  // THE authorization step. Throws before any CRM code runs.
  const tenant = requireWorkspaceAccess(actor, targetWorkspaceId);

  return {
    deps: { db: getDependencies().db, events: getEventPublisher() },
    tenant,
    correlationId: request.correlationId,
  };
}

/**
 * Resolve a CRM context and assert a capability up front.
 *
 * The services check capabilities themselves — this is belt-and-braces for
 * route handlers, so an unauthorized request is refused before its body is
 * even parsed.
 */
export async function requireCrmContextWith(
  request: RequestContext,
  capability: Capability,
  workspaceIdOverride?: string | undefined,
): Promise<CrmContext> {
  const context = await requireCrmContext(request, workspaceIdOverride);
  const { workspaceRoleHasCapability } = await import('@growth-os/contracts');

  if (!workspaceRoleHasCapability(context.tenant.workspace.role, capability)) {
    throw new AuthorizationError(`User ${context.tenant.actor.userId} lacks ${capability}`, {
      details: { capability, role: context.tenant.workspace.role },
    });
  }

  return context;
}
