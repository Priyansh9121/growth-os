/**
 * Cookie definitions for authentication and workspace scope.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Declares the name and attributes of every cookie Growth OS sets. Framework
 * agnostic: these are plain descriptors that a Next.js route handler, a
 * Fastify reply or a test can each apply in their own way.
 *
 * @see docs/security/authentication.md
 */

/**
 * Session cookie name.
 *
 * The `__Host-` prefix is deliberately NOT used. It would be stronger (the
 * browser enforces Secure, Path=/ and no Domain), but it also requires HTTPS
 * unconditionally — which would break local development over http and lead to
 * a different cookie name per environment. Environment-dependent cookie names
 * are a reliable source of "it works locally" incidents. Revisit once local
 * development runs over TLS.
 */
export const SESSION_COOKIE_NAME = 'gos_session';

/**
 * Remembers the user's last active workspace.
 *
 * A UX preference and NEVER a grant. Its value is always validated against the
 * actor's resolved memberships before use (see `resolveActiveWorkspace`), so
 * editing it yields no access. It is not httpOnly because no secret is in it
 * and client code may legitimately read it.
 */
export const WORKSPACE_COOKIE_NAME = 'gos_workspace';

export interface CookieAttributes {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict' | 'none';
  readonly path: string;
  readonly maxAge: number;
}

/**
 * Attributes for the session cookie.
 *
 * - `httpOnly`  — JavaScript cannot read it, so an XSS payload cannot exfiltrate
 *   the session. This is the single most valuable attribute here and is why the
 *   token is not kept in `localStorage`.
 * - `secure`    — derived from whether `APP_URL` is https, not from NODE_ENV, so
 *   a production-like local build over http still works while every https
 *   deployment gets it automatically.
 * - `sameSite: 'lax'` — blocks the cookie on cross-site sub-requests (the CSRF
 *   vector) while still sending it on top-level navigation, so following a link
 *   into the app keeps you signed in. `strict` would break that and is a poor
 *   trade for a product people link into from email and reports.
 * - `path: '/'`  — the whole application.
 */
export function sessionCookieAttributes(secure: boolean, maxAgeSeconds: number): CookieAttributes {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** Attributes that expire a cookie immediately. Used on sign-out. */
export function expiredCookieAttributes(secure: boolean): CookieAttributes {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  };
}

export function workspaceCookieAttributes(
  secure: boolean,
  maxAgeSeconds: number,
): CookieAttributes {
  return {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
