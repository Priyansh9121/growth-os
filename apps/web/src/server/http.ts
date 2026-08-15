import 'server-only';

/**
 * HTTP transport helpers: error rendering, correlation IDs and request context.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Translates the domain's typed errors into HTTP responses mechanically. Route
 * handlers never choose a status code or compose a user-facing message —
 * that decision belongs to the code that knows what went wrong, and lives in
 * the `AppError` subclass.
 *
 * THE SECURITY INVARIANT
 * Only `AppError.publicMessage` reaches a client. Stack traces, database
 * messages and `details` are logged, never serialised into a response. An
 * unrecognised throw becomes a generic 500 with a correlation ID.
 *
 * @see docs/engineering/error-handling.md
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { RateLimitError, isAppError, toAppError, type PublicErrorBody } from '@growth-os/contracts';
import { extractClientIp, isTrustedOrigin, normaliseUserAgent } from '@growth-os/auth';
import { getDependencies } from './dependencies';

/** Header carrying the correlation ID back to the client, for support requests. */
export const CORRELATION_HEADER = 'x-growth-request-id';

export interface RequestContext {
  readonly correlationId: string;
  readonly ipAddress: string;
  readonly userAgent: string | undefined;
}

/**
 * Derive the per-request context used for logging, auditing and rate limiting.
 *
 * Honours an inbound correlation ID so a request traced from the browser or an
 * upstream proxy keeps one identifier end to end. It is length-capped and
 * pattern-restricted because it is attacker-controlled and ends up in logs —
 * unbounded, unfiltered input in a log line is a log-injection vector.
 */
export function buildRequestContext(request: Request): RequestContext {
  const { env } = getDependencies();
  const inbound = request.headers.get(CORRELATION_HEADER);
  const correlationId = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : randomUUID();

  return {
    correlationId,
    ipAddress: extractClientIp(request.headers, null, env.TRUSTED_PROXY),
    userAgent: normaliseUserAgent(request.headers.get('user-agent')),
  };
}

/**
 * Reject a state-changing request that did not originate from our own origin.
 *
 * Returns a response when the request should be refused, `null` when it may
 * proceed. Fails closed on a missing `Origin` and `Referer` — see
 * `isTrustedOrigin` for why absence is treated as hostile.
 */
export function rejectUntrustedOrigin(
  request: Request,
  context: RequestContext,
): NextResponse | null {
  const { env } = getDependencies();

  const trusted = isTrustedOrigin(
    request.headers.get('origin'),
    request.headers.get('referer'),
    env.APP_URL,
  );

  if (trusted) return null;

  console.warn('[security] rejected request with untrusted origin', {
    correlationId: context.correlationId,
    origin: request.headers.get('origin'),
    path: new URL(request.url).pathname,
  });

  return NextResponse.json(
    {
      error: {
        code: 'authorization_error',
        message: 'Request origin could not be verified.',
        correlationId: context.correlationId,
      },
    } satisfies PublicErrorBody,
    { status: 403, headers: { [CORRELATION_HEADER]: context.correlationId } },
  );
}

/**
 * Render any thrown value as a safe HTTP response.
 *
 * Non-operational errors (bugs, unreachable dependencies) are logged at
 * `error`; operational ones (bad password, rate limited) at `info`, because
 * they are business as usual and must not page anyone.
 */
export function errorResponse(error: unknown, context: RequestContext): NextResponse {
  const appError = toAppError(error);

  const logPayload = {
    correlationId: context.correlationId,
    code: appError.code,
    name: appError.name,
    // The internal message, which may be specific — logs only, never the body.
    message: appError.message,
    details: appError.details,
  };

  if (appError.isOperational) {
    console.info('[request] handled error', logPayload);
  } else {
    console.error('[request] unhandled error', { ...logPayload, stack: appError.stack });
  }

  const headers: Record<string, string> = { [CORRELATION_HEADER]: context.correlationId };

  if (appError instanceof RateLimitError) {
    headers['Retry-After'] = String(appError.retryAfterSeconds);
  }

  return NextResponse.json(appError.toPublicJSON(context.correlationId), {
    status: appError.httpStatus,
    headers,
  });
}

/** Success response carrying the correlation header. */
export function jsonResponse<T>(body: T, context: RequestContext, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { [CORRELATION_HEADER]: context.correlationId },
  });
}

export { isAppError };
