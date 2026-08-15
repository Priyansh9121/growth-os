/**
 * The CRM execution context and its authorization guards.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Every CRM service takes a `CrmContext` as its first argument. That context
 * carries an already-authorized `TenantActor`, so a service can never be
 * invoked without a caller and a workspace having been established.
 *
 * THE IDOR DEFENCE, EXPRESSED AS AN API SHAPE
 * There is deliberately no `findById(id)` anywhere in this package. The only
 * way to load a row is `loadInTenant`, which requires the workspace and
 * filters on it. The insecure form — fetch by id, then check `row.workspaceId`
 * afterwards — is not merely discouraged here; it is not expressible, because
 * no function offers it.
 *
 * WHY THIS PACKAGE DOES NOT IMPORT @growth-os/auth
 * Capability checks resolve through `workspaceRoleHasCapability` from
 * `contracts`. Importing `auth` would create a cycle and couple the CRM to how
 * authentication happened, which the voice service (Stage 13) will not share.
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 * @see docs/security/tenant-isolation.md
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

export interface CrmDependencies {
  readonly db: Database;
  readonly events: DomainEventPublisher;
  /** Injectable clock. Tests need determinism; production passes nothing. */
  readonly now?: () => Date;
}

export interface CrmContext {
  readonly deps: CrmDependencies;
  /** Proof that the caller was authorized for this workspace. */
  readonly tenant: TenantActor;
  /** Ties every write back to the originating request and the audit trail. */
  readonly correlationId: string | null;
}

export function contextNow(context: CrmContext): Date {
  return context.deps.now?.() ?? new Date();
}

export function workspaceId(context: CrmContext): string {
  return context.tenant.workspace.workspaceId;
}

export function actorUserId(context: CrmContext): string {
  return context.tenant.actor.userId;
}

/**
 * Assert the caller holds `capability` in the active workspace.
 *
 * Called at the top of every service function that reads or writes. The
 * thrown `AuthorizationError` renders as a 403 whose body reveals nothing
 * about whether the target exists.
 *
 * @throws AuthorizationError
 */
export function requireCapability(context: CrmContext, capability: Capability): void {
  if (!workspaceRoleHasCapability(context.tenant.workspace.role, capability)) {
    throw new AuthorizationError(
      `User ${actorUserId(context)} lacks ${capability} in workspace ${workspaceId(context)}`,
      {
        details: {
          userId: actorUserId(context),
          workspaceId: workspaceId(context),
          capability,
          role: context.tenant.workspace.role,
          via: context.tenant.workspace.via,
        },
      },
    );
  }
}

/**
 * Run `fn` inside a transaction scoped to the caller's workspace.
 *
 * Opens `withTenantTransaction`, which issues `SET LOCAL app.workspace_id`, so
 * every statement inside is additionally constrained by row-level security.
 * Application-level filtering and the database backstop both apply.
 */
export async function inTenant<T>(
  context: CrmContext,
  fn: (tx: TenantTransaction, workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = workspaceId(context);
  return withTenantTransaction(context.deps.db, workspace, (tx) => fn(tx, workspace));
}

/**
 * Minimal structural type for a tenant-scoped table.
 *
 * Every CRM table has `id` and `workspace_id`; requiring both here means a
 * table that forgot its tenancy column **cannot be passed to the loader at
 * all** — the omission becomes a compile error rather than a missing filter.
 *
 * Deliberately `PgTable` rather than `PgTableWithColumns<TableConfig>`: the
 * latter demands a string index signature that Drizzle's concrete table types
 * do not satisfy, which would force every call site into a cast — and a cast
 * at a security boundary defeats the purpose of typing it.
 */
type TenantTable = PgTable & {
  readonly id: PgColumn;
  readonly workspaceId: PgColumn;
};

/**
 * Load exactly one row by ID, scoped to the tenant.
 *
 * **This is the only sanctioned way to resolve a `:id` route parameter.**
 * The workspace predicate is part of the query, not a check performed on the
 * result — so a row belonging to another tenant is never loaded into memory,
 * let alone inspected.
 *
 * Raises `NotFoundError`, never `AuthorizationError`, when the row is absent
 * OR belongs to another workspace. Distinguishing the two would confirm that
 * another tenant holds a record with that ID.
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
    // `as PgTable` narrows away Drizzle's `TableLikeHasEmptySelection` guard,
    // which cannot be evaluated against an unresolved generic. The call site
    // keeps its type safety from the `TenantTable` constraint above; this cast
    // only satisfies an internal conditional type.
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

/**
 * Tenant predicate for list queries.
 *
 * Redundant with RLS by design: defence in depth means the application states
 * its intent explicitly AND the database enforces it independently.
 */
export function tenantScope<TTable extends TenantTable>(table: TTable, workspace: string): SQL {
  return eq(table.workspaceId, workspace) as SQL;
}
