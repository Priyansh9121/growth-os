/**
 * The authenticated subject of a request, with tenancy resolved.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * An `Actor` is constructed exactly once per request, at the boundary, and
 * then passed down. Nothing below the boundary re-reads cookies, re-queries
 * memberships, or decides who the caller is — which means there is one place
 * where identity can be wrong, not many.
 *
 * These are pure types. Construction lives in `@growth-os/auth`, which is
 * where database access is allowed.
 */

import type { AgencyRole, Capability, WorkspaceRole } from './capabilities';

/**
 * How a user reached a workspace.
 *
 * This is not cosmetic. Stage 16 requires agency-derived access to be
 * separately auditable — an audit trail must distinguish "the client's own
 * admin did this" from "their agency did this on their behalf".
 */
export type AccessPath = 'direct' | 'agency';

/** One workspace the actor may operate, with the effective role resolved. */
export interface WorkspaceAccess {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  /** Present when the workspace is owned by an agency. */
  readonly agencyId: string | null;
  /**
   * The effective role. Where both a direct membership and an agency
   * membership exist, this is the stronger of the two.
   */
  readonly role: WorkspaceRole;
  /** `'direct'` when a direct membership contributed the effective role. */
  readonly via: AccessPath;
}

export interface AgencyAccess {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly agencySlug: string;
  readonly role: AgencyRole;
}

/**
 * A fully resolved authenticated caller.
 *
 * `workspaces` is the complete set the actor may touch. Authorization is a
 * lookup in this set — never a fresh database query further down the stack,
 * which is how time-of-check/time-of-use gaps appear.
 */
export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly sessionId: string;
  readonly workspaces: readonly WorkspaceAccess[];
  readonly agencies: readonly AgencyAccess[];
}

/**
 * An actor bound to one workspace for the duration of an operation.
 *
 * Application services take a `TenantActor`, never a bare `Actor` plus a
 * workspace ID. Making the bound pair a single value means a service cannot
 * be called with a workspace the caller was never authorized for — the type
 * system carries the proof, and forgetting the check becomes a compile error
 * rather than a silent breach.
 */
export interface TenantActor {
  readonly actor: Actor;
  readonly workspace: WorkspaceAccess;
}

/** Client-safe projection of an actor. Contains no session identifier. */
export interface SessionUserView {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly workspaces: readonly WorkspaceAccess[];
  readonly agencies: readonly AgencyAccess[];
  readonly activeWorkspaceId: string | null;
}

/**
 * Project an actor for delivery to the browser.
 *
 * Deliberately drops `sessionId`: the session identifier is a secret that
 * belongs in an httpOnly cookie and a server-side row, never in a React prop
 * that ends up serialised into the HTML payload.
 */
export function toSessionUserView(actor: Actor, activeWorkspaceId: string | null): SessionUserView {
  return {
    userId: actor.userId,
    email: actor.email,
    name: actor.name,
    workspaces: actor.workspaces,
    agencies: actor.agencies,
    activeWorkspaceId,
  };
}

export type { AgencyRole, Capability, WorkspaceRole };
