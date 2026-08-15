/**
 * Authorization guards — the application layer of tenant isolation.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Every authorization decision in Growth OS goes through this file. These are
 * pure functions over an already-resolved `Actor`: no I/O, no database, no
 * request object. That makes them exhaustively unit-testable, and it means a
 * test proving "user in workspace A cannot reach workspace B" is testing the
 * real control rather than a mock of it.
 *
 * THE CONVENTION
 *   `can*`      → returns a boolean. For UI decisions (should I show this?).
 *   `require*`  → returns the value or THROWS AuthorizationError. For access.
 *
 * Only `require*` guards a data path. A `can*` check controls what is
 * rendered, never what is permitted — a hidden button is not a security
 * control.
 *
 * @see docs/security/tenant-isolation.md
 * @see docs/architecture/multi-tenancy.md
 */

import {
  AuthorizationError,
  agencyRoleHasCapability,
  workspaceRoleHasCapability,
  type Actor,
  type AgencyAccess,
  type Capability,
  type TenantActor,
  type WorkspaceAccess,
} from '@growth-os/contracts';

/** Does the actor have any access to this workspace? */
export function canAccessWorkspace(actor: Actor, workspaceId: string): boolean {
  return actor.workspaces.some((workspace) => workspace.workspaceId === workspaceId);
}

export function getWorkspaceAccess(actor: Actor, workspaceId: string): WorkspaceAccess | undefined {
  return actor.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
}

/** Does the actor hold `capability` in this workspace? */
export function canInWorkspace(actor: Actor, workspaceId: string, capability: Capability): boolean {
  const access = getWorkspaceAccess(actor, workspaceId);
  return access !== undefined && workspaceRoleHasCapability(access.role, capability);
}

/**
 * Assert access to a workspace and return the bound `TenantActor`.
 *
 * **This is the function that enforces tenant isolation at the application
 * layer.** Every tenant-scoped operation begins here.
 *
 * Returning a `TenantActor` rather than a boolean is a deliberate design
 * choice: application services accept a `TenantActor`, never a bare `Actor`
 * plus a workspace ID. The only way to obtain one is to pass this check, so
 * "forgot to authorize" becomes a compile error instead of a silent breach.
 *
 * WHY THE ERROR IS UNIFORM
 * A missing workspace and an unauthorized workspace raise the identical
 * error. Distinguishing them would confirm the existence of another tenant's
 * workspace to anyone who can guess an ID.
 *
 * @throws AuthorizationError
 */
export function requireWorkspaceAccess(
  actor: Actor,
  workspaceId: string,
  capability?: Capability,
): TenantActor {
  const workspace = getWorkspaceAccess(actor, workspaceId);

  if (!workspace) {
    throw new AuthorizationError(
      `User ${actor.userId} attempted to access workspace ${workspaceId} without membership`,
      { details: { userId: actor.userId, workspaceId, reason: 'no_membership' } },
    );
  }

  if (capability !== undefined && !workspaceRoleHasCapability(workspace.role, capability)) {
    throw new AuthorizationError(
      `User ${actor.userId} lacks capability ${capability} in workspace ${workspaceId}`,
      {
        details: {
          userId: actor.userId,
          workspaceId,
          capability,
          role: workspace.role,
          reason: 'missing_capability',
        },
      },
    );
  }

  return { actor, workspace };
}

export function canAccessAgency(actor: Actor, agencyId: string): boolean {
  return actor.agencies.some((agency) => agency.agencyId === agencyId);
}

/** @throws AuthorizationError */
export function requireAgencyAccess(
  actor: Actor,
  agencyId: string,
  capability?: Capability,
): AgencyAccess {
  const agency = actor.agencies.find((candidate) => candidate.agencyId === agencyId);

  if (!agency) {
    throw new AuthorizationError(
      `User ${actor.userId} attempted to access agency ${agencyId} without membership`,
      { details: { userId: actor.userId, agencyId, reason: 'no_membership' } },
    );
  }

  if (capability !== undefined && !agencyRoleHasCapability(agency.role, capability)) {
    throw new AuthorizationError(
      `User ${actor.userId} lacks capability ${capability} in agency ${agencyId}`,
      { details: { userId: actor.userId, agencyId, capability, role: agency.role } },
    );
  }

  return agency;
}

/**
 * Choose the workspace a request operates on.
 *
 * Resolution order:
 *   1. an explicit request parameter
 *   2. the `gos_workspace` cookie hint
 *   3. the first accessible workspace, deterministically ordered
 *
 * **The cookie is a preference, never a grant.** Its value is validated
 * against the actor's resolved memberships here; a user who edits it to
 * another workspace's ID simply falls through to their default rather than
 * gaining anything. This is the correct treatment for any client-supplied
 * scope hint.
 *
 * Returns `null` when the actor has no workspaces at all — a real state for a
 * newly invited agency user, which the UI must handle rather than crash on.
 */
export function resolveActiveWorkspace(
  actor: Actor,
  requested?: string | null,
  cookieHint?: string | null,
): WorkspaceAccess | null {
  if (requested) {
    const explicit = getWorkspaceAccess(actor, requested);
    if (explicit) return explicit;
    // An explicit, unauthorized request is an error rather than a silent
    // fallback: the caller asked for specific data and must not be handed
    // different data without knowing.
    throw new AuthorizationError(
      `User ${actor.userId} requested workspace ${requested} without membership`,
      { details: { userId: actor.userId, workspaceId: requested, reason: 'no_membership' } },
    );
  }

  if (cookieHint) {
    const hinted = getWorkspaceAccess(actor, cookieHint);
    if (hinted) return hinted;
    // A stale hint (access revoked, workspace deleted) falls through silently.
  }

  return actor.workspaces[0] ?? null;
}
