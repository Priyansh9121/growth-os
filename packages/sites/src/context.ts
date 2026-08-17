/**
 * The sites execution context.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Mirrors `FormsContext`, which mirrors `CrmContext`: the same tenant-scoped
 * transaction, the same capability check, the same shape. Sites are a different
 * domain but not a different security model — and two security models is how
 * one of them ends up weaker.
 *
 * ⚠️ IT SUPPORTS A SYSTEM ACTOR, WHICH `FormsContext` DOES NOT.
 * A scheduled crawl re-verifies a site with no human involved, and the honest
 * record of who did that is "the system" (ADR-0025). `actorUserId` therefore
 * THROWS on a system context rather than returning a placeholder, so a service
 * that has not been reviewed for system safety stops at the call instead of
 * writing a fabricated foreign key.
 */

import { and, eq, type InferSelectModel, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  AuthorizationError,
  NotFoundError,
  workspaceRoleHasCapability,
  type Capability,
  type DomainEventPublisher,
  type TenantActor,
} from '@growth-os/contracts';
import { withTenantTransaction, type Database, type TenantTransaction } from '@growth-os/database';

export interface SitesDependencies {
  readonly db: Database;
  readonly events: DomainEventPublisher;
  /** Injectable clock. Tests need determinism; production passes nothing. */
  readonly now?: () => Date;
}

/**
 * A non-human caller, granted explicit capabilities.
 *
 * The same mechanism the public form path uses (ADR-0025). A grant of exactly
 * what the operation needs, never a workspace role — the weakest role holding
 * `sites:verify` also holds seventeen other things.
 */
export interface SystemGrant {
  /** Appears in audit records. `scheduled_crawl`, `crawl:<id>`. */
  readonly label: string;
  readonly capabilities: readonly Capability[];
}

export interface SitesContext {
  readonly deps: SitesDependencies;
  readonly tenant: TenantActor;
  readonly correlationId: string | null;
  readonly system?: SystemGrant;
}

export function contextNow(context: SitesContext): Date {
  return context.deps.now?.() ?? new Date();
}

export function workspaceId(context: SitesContext): string {
  return context.tenant.workspace.workspaceId;
}

/**
 * The acting user's id.
 *
 * ⚠️ THROWS ON A SYSTEM CONTEXT. Not returns null — throws. A caller that has
 * not been reviewed for system safety stops here rather than writing a
 * fabricated user id into a foreign key, which is how a fake human ends up in
 * an audit trail whose entire purpose is answering "who did this?".
 */
export function actorUserId(context: SitesContext): string {
  if (context.system) {
    throw new Error(
      `actorUserId called on the system context "${context.system.label}". ` +
        'Use actorUserIdOrNull, and record actor_type = system.',
    );
  }
  return context.tenant.actor.userId;
}

/** Null for the system, which is the honest value for `created_by_user_id`. */
export function actorUserIdOrNull(context: SitesContext): string | null {
  return context.system ? null : context.tenant.actor.userId;
}

/** @throws AuthorizationError */
export function requireCapability(context: SitesContext, capability: Capability): void {
  // A system grant is consulted INSTEAD of the role, never in addition. The
  // grant is the whole authority, so a grant that omits a capability denies it
  // even when the (never-consulted) role would have allowed it.
  const permitted = context.system
    ? context.system.capabilities.includes(capability)
    : workspaceRoleHasCapability(context.tenant.workspace.role, capability);

  if (permitted) return;

  throw new AuthorizationError(
    context.system
      ? `System actor "${context.system.label}" was not granted ${capability}`
      : `User ${context.tenant.actor.userId} lacks ${capability} in workspace ${workspaceId(context)}`,
    {
      details: {
        ...(context.system
          ? { system: context.system.label }
          : { userId: context.tenant.actor.userId }),
        workspaceId: workspaceId(context),
        capability,
      },
    },
  );
}

export async function inTenant<T>(
  context: SitesContext,
  fn: (tx: TenantTransaction, workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = workspaceId(context);
  return withTenantTransaction(context.deps.db, workspace, (tx) => fn(tx, workspace));
}

type TenantTable = PgTable & {
  readonly id: PgColumn;
  readonly workspaceId: PgColumn;
};

export function tenantScope(table: TenantTable, workspace: string): SQL {
  return eq(table.workspaceId, workspace);
}

/**
 * Load one row by id, scoped to the tenant.
 *
 * ⚠️ THERE IS NO `findById`, DELIBERATELY. The IDOR defence is the API's shape:
 * the only way to load a row is a call that requires a workspace, so "forgot to
 * scope it" is not expressible (the same rule as `@growth-os/crm`).
 */
export async function loadInTenant<T extends TenantTable>(
  tx: TenantTransaction,
  table: T,
  workspace: string,
  id: string,
  label: string,
): Promise<InferSelectModel<T>> {
  const [row] = await tx
    .select()
    // The cast is Drizzle's, not ours: `.from()` is generic over a table-like
    // whose selection is non-empty, and a bare type parameter cannot prove
    // that. `@growth-os/forms` and `@growth-os/crm` carry the identical cast
    // for the identical reason.
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspace)))
    .limit(1);

  // A row in another workspace and a row that does not exist produce the SAME
  // error. Distinguishing them would confirm the existence of another tenant's
  // record to anyone who can guess a UUID.
  if (!row) throw new NotFoundError(`${label} ${id} not found in workspace ${workspace}`);
  return row as InferSelectModel<T>;
}
