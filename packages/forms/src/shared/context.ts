/**
 * The lead capture execution context and its guards.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Mirrors `@growth-os/crm`'s `CrmContext` deliberately: same tenant-scoped
 * transaction, same `loadInTenant` shape, same capability check. Forms are a
 * different domain but not a different security model, and two different
 * models is how one of them ends up weaker.
 *
 * @see packages/crm/src/shared/context.ts — the pattern this follows
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

export interface FormsDependencies {
  readonly db: Database;
  readonly events: DomainEventPublisher;
  /** Injectable clock. Tests need determinism; production passes nothing. */
  readonly now?: () => Date;
}

export interface FormsContext {
  readonly deps: FormsDependencies;
  readonly tenant: TenantActor;
  readonly correlationId: string | null;
}

export function contextNow(context: FormsContext): Date {
  return context.deps.now?.() ?? new Date();
}

export function workspaceId(context: FormsContext): string {
  return context.tenant.workspace.workspaceId;
}

export function actorUserId(context: FormsContext): string {
  return context.tenant.actor.userId;
}

/** @throws AuthorizationError */
export function requireCapability(context: FormsContext, capability: Capability): void {
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
  context: FormsContext,
  fn: (tx: TenantTransaction, workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = workspaceId(context);
  return withTenantTransaction(context.deps.db, workspace, (tx) => fn(tx, workspace));
}

type TenantTable = PgTable & {
  readonly id: PgColumn;
  readonly workspaceId: PgColumn;
};

/**
 * Load one row by id, scoped to the tenant.
 *
 * The same IDOR defence as the CRM: the workspace predicate is part of the
 * query, not a check on the result, so another tenant's row is never loaded
 * into memory. A foreign id produces `NotFoundError` — never
 * `AuthorizationError`, which would confirm it exists somewhere.
 *
 * @throws NotFoundError
 */
export async function loadInTenant<TTable extends TenantTable>(
  tx: TenantTransaction,
  table: TTable,
  workspace: string,
  id: string,
  extraConditions: SQL[] = [],
): Promise<InferSelectModel<TTable>> {
  const [row] = await tx
    .select()
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspace), ...extraConditions))
    .limit(1);

  if (!row) {
    throw new NotFoundError(`Record ${id} not found in workspace ${workspace}`, {
      details: { id, workspaceId: workspace },
    });
  }

  return row as InferSelectModel<TTable>;
}

export function tenantScope<TTable extends TenantTable>(table: TTable, workspace: string): SQL {
  return eq(table.workspaceId, workspace) as SQL;
}
