/**
 * Edge proxy — Content Security Policy and unauthenticated navigation routing.
 *
 * ⚠️  THIS IS NOT AN AUTHORIZATION BOUNDARY. READ THIS BEFORE ADDING TO IT.
 *
 * Two responsibilities, in order of importance:
 *
 *  1. **Generate a per-request CSP nonce** and set the policy. This is the
 *     Stage 2 closure of the Stage 1 "no CSP" debt (ADR-0017).
 *  2. Redirect a browser with no session cookie away from an application
 *     route, cheaply, before a full server render.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - It does NOT validate the session. It only sees that a cookie exists, not
 *    whether its value corresponds to a live session row.
 *  - It does NOT authorize anything. No database access, no membership
 *    knowledge.
 *
 * Treating Next.js edge middleware/proxy as a security boundary is a common
 * and serious mistake: it can be bypassed in several deployment topologies,
 * and past CVEs have allowed skipping it outright with a crafted header. Every
 * real decision is made in `app/(app)/layout.tsx` and the route handlers,
 * where the session is validated against the database.
 *
 * The correct mental model: **a user holding a forged or expired cookie passes
 * this proxy and is then rejected by the server.** That is by design.
 *
 * @see apps/web/src/server/auth-context.ts — the real boundary
 * @see docs/decisions/ADR-0017-content-security-policy.md
 */

import { NextResponse, type NextRequest } from 'next/server';

/** Must match SESSION_COOKIE_NAME in @growth-os/auth. */
const SESSION_COOKIE = 'gos_session';

/**
 * Route prefixes that require a session.
 *
 * Kept as an explicit list INSIDE the function rather than expressed in the
 * matcher, because the matcher now covers every page so that CSP applies
 * everywhere. Widening the matcher must not widen the redirect.
 */
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/growth',
  '/seo',
  '/customers',
  '/ai',
  '/conversion',
  '/analytics',
  '/system',
] as const;

/**
 * Build the Content-Security-Policy for one request.
 *
 * Follows the Next.js 16 nonce contract: the nonce is set on the REQUEST
 * headers (as both `x-nonce` and `Content-Security-Policy`) so Next.js can
 * parse it out and apply it to framework scripts, page bundles and its own
 * inline tags automatically.
 *
 * THE DIRECTIVES THAT MATTER
 *  - `script-src 'nonce-X' 'strict-dynamic'` — an injected script has no valid
 *    nonce, so it does not execute. `strict-dynamic` lets Next's own bootstrap
 *    load its chunks without whitelisting every URL. NEVER add
 *    `'unsafe-inline'` here: that defeats the entire point of the policy.
 *  - `style-src-attr 'unsafe-inline'` — a deliberate, bounded relaxation. The
 *    dashboard entrance choreography and React Three Fiber both set CSS custom
 *    properties via inline `style` ATTRIBUTES, which `style-src` blocks unless
 *    handled. Scoping it to `-attr` permits attributes only, not inline
 *    `<style>` elements. An inline style attribute cannot execute JavaScript
 *    in any current browser. Full analysis in ADR-0017.
 *  - `frame-ancestors 'none'` supersedes X-Frame-Options in modern browsers.
 *  - `form-action 'self'` blocks credential exfiltration to an external
 *    endpoint — directly relevant to a login form.
 *  - `base-uri 'self'` blocks `<base>` hijacking of relative script URLs.
 *
 * Development additionally needs `'unsafe-eval'` (React uses `eval` to
 * reconstruct server error stacks) and `'unsafe-inline'` styles (the dev
 * server injects unnonced style tags). Neither reaches production, and a test
 * asserts that.
 */
function buildCsp(nonce: string, isDev: boolean): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');
}

export default function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const isDev = process.env.NODE_ENV === 'development';

  // 16 bytes of entropy, base64. A nonce must be unpredictable and unique per
  // request — a reused nonce is equivalent to 'unsafe-inline'.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, isDev);

  // Report-only is available for a staging soak. It defaults OFF: a
  // report-only policy left on indefinitely is the most common way CSP
  // projects quietly fail to protect anything.
  const headerName =
    process.env['CSP_REPORT_ONLY'] === 'true'
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next.js reads the nonce from the REQUEST's CSP header. Always the
  // enforcing name here, so nonce injection still happens in report-only mode.
  requestHeaders.set('Content-Security-Policy', csp);

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  // Presence only — the value is never inspected or trusted.
  if (isProtected && !request.cookies.has(SESSION_COOKIE)) {
    const loginUrl = new URL('/login', request.url);
    // A relative path we constructed, not user input. It is re-validated by
    // `sanitiseRedirect` on the way back out, so the round trip cannot become
    // an open redirect.
    loginUrl.searchParams.set('next', `${pathname}${search}`);
    const redirect = NextResponse.redirect(loginUrl);
    redirect.headers.set(headerName, csp);
    return redirect;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  return response;
}

/**
 * Every page request, so CSP is applied everywhere.
 *
 * Excluded: `api` (JSON responses; CSP is irrelevant and these must return 401
 * rather than redirect), `_next/static` and `_next/image` (immutable assets),
 * `favicon.ico`, and `next/link` prefetches — which fetch RSC payloads, not
 * documents, and would otherwise burn a nonce per hovered link.
 */
export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
