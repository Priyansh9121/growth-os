/**
 * The agent-platform execution context and its guards.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Mirrors `@growth-os/forms`'s `FormsContext`, which mirrors `@growth-os/crm`'s
 * `CrmContext`, deliberately: same tenant-scoped transaction, same capability
 * check, same error types. The agent platform is a different domain but not a
 * different security model, and two different models is how one of them ends
 * up weaker.
 *
 * ⚠️ NO NEW CAPABILITY IS DEFINED HERE.
 * `workspace:ai:query` already exists in `contracts/src/tenancy/capabilities.ts`
 * and is granted to member, admin and owner but not viewer — exactly the shape
 * this service needs. A `workspace:agent_outputs:read` would be a second
 * vocabulary for "may this actor use the AI surface", and the one nothing else
 * reads is the one that drifts. Same reasoning as ADR-0063's autonomy call.
 *
 * @see packages/forms/src/shared/context.ts — the pattern this follows
 * @see docs/decisions/ADR-0065-guardrail-corpus-assembly.md
 */

import {
  AuthorizationError,
  workspaceRoleHasCapability,
  type Capability,
  type TenantActor,
} from '@growth-os/contracts';
import { withTenantTransaction, type Database, type TenantTransaction } from '@growth-os/database';

export interface AgentsDependencies {
  readonly db: Database;
  /** Injectable clock. Tests need determinism; production passes nothing. */
  readonly now?: () => Date;
}

export interface AgentsContext {
  readonly deps: AgentsDependencies;
  readonly tenant: TenantActor;
  readonly correlationId: string | null;
}

export function contextNow(context: AgentsContext): Date {
  return context.deps.now?.() ?? new Date();
}

export function workspaceId(context: AgentsContext): string {
  return context.tenant.workspace.workspaceId;
}

export function actorUserId(context: AgentsContext): string {
  return context.tenant.actor.userId;
}

/** @throws AuthorizationError */
export function requireCapability(context: AgentsContext, capability: Capability): void {
  if (!workspaceRoleHasCapability(context.tenant.workspace.role, capability)) {
    throw new AuthorizationError(
      `User ${actorUserId(context)} lacks ${capability} in workspace ${workspaceId(context)}`,
      {
        details: {
          userId: actorUserId(context),
          workspaceId: workspaceId(context),
          capability,
          role: context.tenant.workspace.role,
        },
      },
    );
  }
}

export async function inTenant<T>(
  context: AgentsContext,
  fn: (tx: TenantTransaction, workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = workspaceId(context);
  return withTenantTransaction(context.deps.db, workspace, (tx) => fn(tx, workspace));
}
