import 'server-only';

/**
 * CRM context for Server Components.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The Server Component equivalent of `requireCrmContext`, which is shaped for
 * route handlers. Both converge on the same requirement: a `TenantActor`
 * produced by `requireWorkspaceAccess`, which is the only thing CRM services
 * accept.
 *
 * A page has already resolved its actor and workspace through
 * `requireAuthContext` (which redirects when unauthenticated), so this takes
 * them as arguments rather than re-reading cookies — one resolution per
 * request, no time-of-check/time-of-use gap.
 */

import type { Actor, WorkspaceAccess } from '@growth-os/contracts';
import type { CrmContext } from '@growth-os/crm';
import { getDependencies } from './dependencies';
import { getEventPublisher } from './crm-context';

/**
 * Build a CRM context from an already-authorized actor and workspace.
 *
 * The `workspace` argument comes from `requireAuthContext`, which resolved it
 * from the actor's membership graph — so it is authorized by construction. A
 * caller cannot pass an arbitrary workspace ID here, because it is a
 * `WorkspaceAccess`, not a string.
 */
export function buildServerCrmContext(actor: Actor, workspace: WorkspaceAccess): CrmContext {
  return {
    deps: { db: getDependencies().db, events: getEventPublisher() },
    tenant: { actor, workspace },
    correlationId: null,
  };
}
