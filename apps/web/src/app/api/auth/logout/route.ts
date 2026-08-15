/**
 * POST /api/auth/logout
 *
 * Revokes the session SERVER-SIDE and clears the cookie.
 *
 * WHY BOTH, AND IN THAT ORDER
 * Clearing the cookie alone would leave a valid session row: anyone who
 * captured the token (a shared machine, a proxy log, a browser extension)
 * could keep using it until expiry. The row is deleted first so the token is
 * dead even if the cookie deletion is lost.
 *
 * WHY IT ALWAYS RETURNS 200
 * Sign-out is idempotent. A user with an already-expired session clicking
 * "sign out" must not see an error — the outcome they asked for (not being
 * signed in) is achieved either way.
 */

import { NextResponse } from 'next/server';
import {
  expiredCookieAttributes,
  revokeSessionByToken,
  SESSION_COOKIE_NAME,
  WORKSPACE_COOKIE_NAME,
} from '@growth-os/auth';
import { AUDIT_EVENTS, writeAuditEvent } from '@growth-os/database';
import { getDependencies } from '../../../../server/dependencies';
import { buildRequestContext, errorResponse, rejectUntrustedOrigin } from '../../../../server/http';
import { getAuthContext } from '../../../../server/auth-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);

  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const deps = getDependencies();

    // Resolved before revocation so the audit record can attribute the event.
    const auth = await getAuthContext();

    const token = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1);

    if (token) {
      await revokeSessionByToken(deps.db, token, deps.sessionConfig);
    }

    if (auth) {
      await writeAuditEvent(deps.db, {
        workspaceId: null,
        actorUserId: auth.actor.userId,
        eventName: AUDIT_EVENTS.AUTH_LOGOUT,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    }

    const response = NextResponse.json({ ok: true }, { status: 200 });

    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: '',
      ...expiredCookieAttributes(deps.secureCookies),
    });

    // The workspace preference is cleared too: leaving it would preload the
    // previous user's workspace name into the next person's session on a
    // shared machine.
    response.cookies.set({
      name: WORKSPACE_COOKIE_NAME,
      value: '',
      ...expiredCookieAttributes(deps.secureCookies),
      httpOnly: false,
    });

    return response;
  } catch (error) {
    return errorResponse(error, context);
  }
}
