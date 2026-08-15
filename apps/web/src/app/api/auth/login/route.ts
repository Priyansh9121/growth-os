/**
 * POST /api/auth/login
 *
 * ARCHITECTURAL RESPONSIBILITY
 * A thin transport adapter over the `login` use case in `@growth-os/auth`.
 * It parses, delegates, and sets a cookie. It contains NO authentication
 * logic — that all lives in the domain package, which is what keeps it
 * testable without HTTP and portable to a Fastify host later
 * (ADR-0001).
 *
 * Read `packages/auth/src/login.ts` for the security sequence itself; the
 * ordering there is deliberate and documented.
 *
 * @see docs/security/authentication.md
 */

import { NextResponse } from 'next/server';
import { loginInputSchema, ValidationError, type LoginResponse } from '@growth-os/contracts';
import {
  login,
  sanitiseRedirect,
  sessionCookieAttributes,
  SESSION_COOKIE_NAME,
} from '@growth-os/auth';
import { getDependencies } from '../../../../server/dependencies';
import { buildRequestContext, errorResponse, rejectUntrustedOrigin } from '../../../../server/http';

/**
 * Node runtime, not edge: Argon2 is a native binding and the database driver
 * needs TCP sockets. Neither is available on the edge runtime.
 */
export const runtime = 'nodejs';

/** Never cache an authentication response. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);

  try {
    // CSRF: verify the request came from our own origin before doing any work.
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const body: unknown = await request.json().catch(() => null);
    const parsed = loginInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new ValidationError(
        'Check the details you entered.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const deps = getDependencies();

    const result = await login(
      {
        db: deps.db,
        rateLimiter: deps.rateLimiter,
        sessionConfig: deps.sessionConfig,
        limits: deps.loginLimits,
      },
      parsed.data,
      {
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      },
    );

    // Open-redirect defence. The client may propose a destination; only a
    // same-origin relative path is honoured, anything else falls back.
    const redirectTo = sanitiseRedirect(parsed.data.next ?? null, '/dashboard');

    const responseBody: LoginResponse = {
      ok: true,
      redirectTo,
      user: { userId: result.userId, email: result.email, name: result.name },
    };

    const response = NextResponse.json(responseBody, { status: 200 });

    // The raw token exists only here. It goes into an httpOnly cookie and is
    // never returned in the body, never logged, and never stored client-side
    // in a form JavaScript can read.
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: result.token,
      ...sessionCookieAttributes(deps.secureCookies, deps.env.SESSION_IDLE_TTL),
    });

    return response;
  } catch (error) {
    return errorResponse(error, context);
  }
}
