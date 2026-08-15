/**
 * Authenticated application layout.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The authorization gate for every route in the `(app)` group, and the mount
 * point for the shell.
 *
 * ⚠️ THIS IS A REAL SECURITY BOUNDARY — `proxy.ts` IS NOT.
 * The edge proxy performs a cookie-presence check to redirect unauthenticated
 * navigation cheaply. It does not validate a session and has no database
 * access. Authentication is verified HERE, on the server, before any
 * workspace-scoped content is rendered.
 *
 * Being a Server Component means tenant-scoped data is fetched on the server
 * and only the projected, client-safe view is serialised to the browser — no
 * session token, no membership internals.
 *
 * @see docs/architecture/overview.md §4 Request path
 */

import { toSessionUserView } from '@growth-os/contracts';
import { AppShell } from '../../components/shell/app-shell';
import { requireAuthContext } from '../../server/auth-context';

/**
 * Never statically rendered or cached: output depends on the session cookie,
 * and a cached authenticated page is a cross-user data leak.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Redirects to /login when unauthenticated.
  const { actor, workspace } = await requireAuthContext();

  // `toSessionUserView` deliberately drops `sessionId` — the session
  // identifier is a secret and must not be serialised into the HTML payload
  // that ships to the browser.
  const user = toSessionUserView(actor, workspace?.workspaceId ?? null);

  return <AppShell user={user}>{children}</AppShell>;
}
