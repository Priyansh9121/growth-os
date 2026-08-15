/**
 * Actor resolution — turning a user ID into a fully scoped tenancy context.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Resolves the complete set of workspaces a user may operate, by BOTH access
 * paths, exactly once per request. Everything downstream reads that resolved
 * set; nothing re-queries.
 *
 * WHY RESOLVE EVERYTHING UP FRONT
 * If authorization re-queried per check, a membership revoked mid-request
 * could apply to some checks and not others, and each query site would be an
 * opportunity to get the predicate wrong. One resolution point means one place
 * to audit and one consistent view for the life of the request.
 *
 * @see docs/architecture/multi-tenancy.md
 */

import { eq, or } from 'drizzle-orm';
import type { Database } from '@growth-os/database';
import { schema } from '@growth-os/database';
import {
  AGENCY_ROLE_TO_WORKSPACE_ROLE,
  strongerWorkspaceRole,
  type Actor,
  type AgencyAccess,
  type WorkspaceAccess,
  type WorkspaceRole,
} from '@growth-os/contracts';

/**
 * Build the actor for an authenticated user.
 *
 * Returns `null` when the user no longer exists or has been disabled — the
 * caller treats that identically to an invalid session.
 *
 * NOTE ON THE UNSCOPED QUERIES
 * This function deliberately runs outside `withTenantTransaction`. It is
 * answering "which tenants may this user enter?", which cannot itself be
 * tenant-scoped without circularity. It is one of a small number of
 * legitimately cross-tenant reads, and it only ever returns rows reachable
 * from the user's own membership graph.
 */
export async function resolveActor(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<Actor | null> {
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user || user.disabledAt !== null) return null;

  const [directRows, agencyRows] = await Promise.all([
    // Path 1: direct memberships.
    db
      .select({
        workspaceId: schema.workspaces.id,
        workspaceName: schema.workspaces.name,
        workspaceSlug: schema.workspaces.slug,
        agencyId: schema.workspaces.agencyId,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
      .where(eq(schema.memberships.userId, userId)),

    // Path 2: agency memberships, and every workspace those agencies own.
    db
      .select({
        agencyId: schema.agencies.id,
        agencyName: schema.agencies.name,
        agencySlug: schema.agencies.slug,
        agencyRole: schema.agencyMemberships.role,
      })
      .from(schema.agencyMemberships)
      .innerJoin(schema.agencies, eq(schema.agencies.id, schema.agencyMemberships.agencyId))
      .where(eq(schema.agencyMemberships.userId, userId)),
  ]);

  const agencies: AgencyAccess[] = agencyRows.map((row) => ({
    agencyId: row.agencyId,
    agencyName: row.agencyName,
    agencySlug: row.agencySlug,
    role: row.agencyRole,
  }));

  // Accumulate by workspace ID so a user reaching one workspace by both paths
  // gets a single entry carrying the STRONGER role — never the last one read,
  // which would make effective permissions depend on query ordering.
  const accessByWorkspace = new Map<string, WorkspaceAccess>();

  for (const row of directRows) {
    accessByWorkspace.set(row.workspaceId, {
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceSlug: row.workspaceSlug,
      agencyId: row.agencyId,
      role: row.role,
      via: 'direct',
    });
  }

  if (agencies.length > 0) {
    const agencyRoleById = new Map(agencies.map((agency) => [agency.agencyId, agency.role]));

    const clientWorkspaces = await db
      .select({
        workspaceId: schema.workspaces.id,
        workspaceName: schema.workspaces.name,
        workspaceSlug: schema.workspaces.slug,
        agencyId: schema.workspaces.agencyId,
      })
      .from(schema.workspaces)
      .where(or(...agencies.map((agency) => eq(schema.workspaces.agencyId, agency.agencyId))));

    for (const row of clientWorkspaces) {
      if (row.agencyId === null) continue;
      const agencyRole = agencyRoleById.get(row.agencyId);
      if (!agencyRole) continue;

      const derivedRole: WorkspaceRole = AGENCY_ROLE_TO_WORKSPACE_ROLE[agencyRole];
      const existing = accessByWorkspace.get(row.workspaceId);

      if (!existing) {
        accessByWorkspace.set(row.workspaceId, {
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          workspaceSlug: row.workspaceSlug,
          agencyId: row.agencyId,
          role: derivedRole,
          via: 'agency',
        });
        continue;
      }

      const stronger = strongerWorkspaceRole(existing.role, derivedRole);
      accessByWorkspace.set(row.workspaceId, {
        ...existing,
        role: stronger,
        // `via` records which path produced the effective role, so an audit
        // entry can distinguish the client's own admin from their agency.
        via: stronger === existing.role ? existing.via : 'agency',
      });
    }
  }

  // Deterministic ordering: the "first accessible workspace" default must not
  // change between requests, or a user's landing workspace would flap.
  const workspaces = [...accessByWorkspace.values()].sort((a, b) =>
    a.workspaceName.localeCompare(b.workspaceName),
  );

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionId,
    workspaces,
    agencies,
  };
}
