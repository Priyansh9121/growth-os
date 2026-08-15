/**
 * Edge proxy (formerly `middleware.ts`) — navigation routing only.
 *
 * ⚠️  THIS IS NOT AN AUTHORIZATION BOUNDARY. READ THIS BEFORE ADDING TO IT.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * A cheap UX optimisation: redirect a browser with no session cookie away from
 * an application route without paying for a full server render first.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - It does NOT validate the session. It cannot: it only sees that a cookie
 *    named `gos_session` exists, not whether its value corresponds to a live
 *    session row.
 *  - It does NOT authorize anything. It has no database access and no knowledge
 *    of memberships.
 *
 * WHY THAT MATTERS
 * Treating Next.js edge middleware/proxy as a security boundary is a common and serious
 * mistake. It can be bypassed in several deployment topologies, and past CVEs
 * have allowed skipping it outright with a crafted header. Every real decision
 * is therefore made in `app/(app)/layout.tsx` and in the route handlers, where
 * the session is actually validated against the database.
 *
 * The correct mental model: **a user holding a forged or expired cookie passes
 * this proxy and is then rejected by the server.** That is by design.
 *
 * @see apps/web/src/server/auth-context.ts — the real boundary
 * @see docs/architecture/overview.md §4
 */

import { NextResponse, type NextRequest } from 'next/server';

/** Must match SESSION_COOKIE_NAME in @growth-os/auth. */
const SESSION_COOKIE = 'gos_session';

export default function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // Presence only — the value is never inspected or trusted.
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE);

  if (!hasSessionCookie) {
    const loginUrl = new URL('/login', request.url);
    // `pathname + search` is a relative path we constructed, not user input.
    // It is re-validated by `sanitiseRedirect` on the way back out, so the
    // round trip cannot become an open redirect.
    loginUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

/**
 * Application routes only.
 *
 * `/login` is excluded so an expired cookie does not cause a redirect loop,
 * and API routes are excluded because they must return 401 JSON rather than an
 * HTML redirect a fetch client cannot follow.
 */
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/growth/:path*',
    '/seo/:path*',
    '/customers/:path*',
    '/ai/:path*',
    '/conversion/:path*',
    '/analytics/:path*',
    '/system/:path*',
  ],
};
