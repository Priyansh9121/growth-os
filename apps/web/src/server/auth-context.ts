import 'server-only';

/**
 * Server-side authentication context.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single entry point by which a server component or route handler learns
 * who is calling. Everything downstream receives an already-resolved `Actor`
 * and never re-reads the cookie.
 *
 * ⚠️ THIS — NOT `proxy.ts` — IS THE AUTHORIZATION BOUNDARY.
 * The edge proxy performs a cookie-PRESENCE check to redirect unauthenticated
 * navigation cheaply. It does not validate anything. Treating Next.js edge
 * edge middleware/proxy as an authorization boundary is a common and serious
 * mistake: it can be bypassed in several deployment topologies, and it has no
 * database access. Every real decision is made here.
 *
 * @see docs/architecture/overview.md §4 Request path
 * @see docs/security/authentication.md
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  resolveActiveWorkspace,
  SESSION_COOKIE_NAME,
  validateSession,
  WORKSPACE_COOKIE_NAME,
  resolveActor,
} from '@growth-os/auth';
import { AuthenticationError, type Actor, type WorkspaceAccess } from '@growth-os/contracts';
import { getDependencies } from './dependencies';

export interface AuthenticatedContext {
  readonly actor: Actor;
  /**
   * Null when the user has no workspaces at all — a real state for a newly
   * invited agency user with no clients yet. The UI must handle it rather
   * than assume a workspace always exists.
   */
  readonly workspace: WorkspaceAccess | null;
}

/**
 * Resolve the caller, or `null` when unauthenticated.
 *
 * Use in layouts and components that render differently for signed-in users
 * but do not require authentication.
 */
export async function getAuthContext(): Promise<AuthenticatedContext | null> {
  const { db, sessionConfig } = getDependencies();
  const cookieStore = await cookies();

  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await validateSession(db, token, sessionConfig);
  if (!session) return null;

  const actor = await resolveActor(db, session.userId, session.sessionId);
  if (!actor) return null;

  // The workspace cookie is a UX preference, never a grant. `resolveActiveWorkspace`
  // validates it against the actor's resolved memberships; a tampered value
  // simply falls through to the user's default.
  const workspace = resolveActiveWorkspace(
    actor,
    null,
    cookieStore.get(WORKSPACE_COOKIE_NAME)?.value ?? null,
  );

  return { actor, workspace };
}

/**
 * Require authentication in a Server Component, redirecting to sign-in if absent.
 *
 * The current path is passed as `next` so the user returns where they were
 * heading. That value is re-validated as a same-origin relative path on the
 * way back out (`sanitiseRedirect`), so it cannot become an open redirect.
 */
export async function requireAuthContext(currentPath?: string): Promise<AuthenticatedContext> {
  const context = await getAuthContext();

  if (!context) {
    const target = currentPath ? `/login?next=${encodeURIComponent(currentPath)}` : '/login';
    redirect(target);
  }

  return context;
}

/**
 * Require authentication in a Route Handler.
 *
 * Throws instead of redirecting: an API caller needs a 401, not an HTML
 * redirect it cannot follow.
 *
 * @throws AuthenticationError
 */
export async function requireActor(): Promise<AuthenticatedContext> {
  const context = await getAuthContext();

  if (!context) {
    throw new AuthenticationError('No valid session for request');
  }

  return context;
}
