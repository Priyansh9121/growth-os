/**
 * /api/auth/password-reset — request a link, and consume one.
 *
 * POST                 requests a reset link
 * POST ?action=complete consumes a token and sets the new password
 *
 * BOTH ARE DELIBERATELY UNINFORMATIVE ON FAILURE.
 *
 * The request endpoint returns 202 for an unknown address exactly as it does
 * for a known one, in comparable time. Without that, this is an
 * account-enumeration oracle for the whole product: an attacker learns which
 * of ten thousand addresses are customers by watching the responses.
 *
 * The completion endpoint gives one message for invalid, expired and
 * already-used tokens, so it cannot be used to probe which tokens ever existed.
 *
 * Rate limiting is enforced in the use case, on BOTH the address and the IP,
 * and is the only outcome a caller can distinguish — because leaving someone
 * retrying against a wall with no explanation helps nobody.
 */

import { type NextResponse } from 'next/server';
import {
  completePasswordResetSchema,
  requestPasswordResetSchema,
  ValidationError,
} from '@growth-os/contracts';
import { completePasswordReset, requestPasswordReset } from '@growth-os/auth';
import { getPasswordResetDependencies } from '../../../../server/dependencies';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);

  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const action = new URL(request.url).searchParams.get('action') ?? 'request';
    const body: unknown = await request.json().catch(() => null);

    if (action === 'complete') {
      const parsed = completePasswordResetSchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError(
          'Check the password you entered.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }

      await completePasswordReset(
        getPasswordResetDependencies(),
        parsed.data.token,
        parsed.data.password,
        { ipAddress: context.ipAddress, correlationId: context.correlationId },
      );

      // No session is issued. The user signs in with the new password, which
      // proves they know it — and means a reset link alone is never a session.
      return jsonResponse({ ok: true }, context);
    }

    const parsed = requestPasswordResetSchema.safeParse(body);
    if (!parsed.success) {
      // Even a malformed address gets a generic message. "That is not a valid
      // email" is fine; anything about the account behind it is not.
      throw new ValidationError('Enter a valid email address.');
    }

    await requestPasswordReset(getPasswordResetDependencies(), parsed.data.email, {
      ipAddress: context.ipAddress,
      correlationId: context.correlationId,
    });

    // 202, not 200: the work is accepted, and whether an email was actually
    // sent is deliberately not disclosed.
    return jsonResponse({ ok: true }, context, 202);
  } catch (error) {
    return errorResponse(error, context);
  }
}
