/**
 * Root route.
 *
 * Growth OS has no public marketing surface in this repository, so `/` simply
 * routes to the right place: the dashboard when authenticated, sign-in when
 * not. `requireAuthContext` handles the unauthenticated case by redirecting.
 */
import { redirect } from 'next/navigation';
import { getAuthContext } from '../server/auth-context';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const context = await getAuthContext();
  redirect(context ? '/dashboard' : '/login');
}
