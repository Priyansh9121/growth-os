/**
 * The Growth OS error taxonomy.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Every failure that crosses a module or process boundary is one of these
 * types. Transport layers (HTTP route handlers today, Fastify and the voice
 * service later) translate an `AppError` into a wire response mechanically —
 * they never decide status codes or user-facing wording themselves. That
 * decision belongs to the code that knows what went wrong.
 *
 * THE SECURITY INVARIANT
 * `publicMessage` is the ONLY field that may reach a client. `details`,
 * `cause` and the stack are for logs. This split exists because the most
 * common way products leak internals — database messages, file paths, the
 * existence of a record another tenant owns — is by rendering an exception
 * verbatim. Making the safe field explicit means the unsafe path requires
 * deliberate effort.
 *
 * @see docs/engineering/error-handling.md
 */

/**
 * Stable, machine-readable failure categories. These appear in API responses
 * and in logs, so they are part of our contract: rename one and you break
 * consumers. Add rather than repurpose.
 */
export const ErrorCode = {
  VALIDATION: 'validation_error',
  AUTHENTICATION: 'authentication_error',
  AUTHORIZATION: 'authorization_error',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMIT: 'rate_limited',
  INTEGRATION: 'integration_error',
  INTERNAL: 'internal_error',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Field-level validation problems, safe to return to the submitting client. */
export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

interface AppErrorOptions {
  /** Structured context for logs and debugging. NEVER sent to a client. */
  readonly details?: Record<string, unknown>;
  /** The underlying failure, preserved for the log record. */
  readonly cause?: unknown;
}

/**
 * Base class for every expected failure in the system.
 *
 * `isOperational` distinguishes "the system worked correctly and the answer is
 * no" (bad password, missing record, rate limited) from "the system broke"
 * (a bug, an unreachable dependency). Alerting keys off this: operational
 * errors are business as usual and must not page anyone at 3am, while
 * non-operational errors indicate something needs fixing.
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;

  /**
   * The only message that may be shown to a client. Written for a human who
   * cannot see our logs, and deliberately vague where specificity would leak
   * information (see AuthenticationError).
   */
  abstract readonly publicMessage: string;

  /** False means "a human should look at this". */
  readonly isOperational: boolean = true;

  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    // `cause` is only passed when present: with exactOptionalPropertyTypes,
    // an explicit `undefined` is not assignable to an optional property.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * The client-safe representation. Everything omitted here is omitted on
   * purpose.
   *
   * @param correlationId Request identifier, so a user can quote a reference
   *   to support and we can find the full record in the logs.
   */
  toPublicJSON(correlationId?: string): PublicErrorBody {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(correlationId === undefined ? {} : { correlationId }),
      },
    };
  }
}

export interface PublicErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly correlationId?: string;
    readonly issues?: readonly FieldIssue[];
  };
}

/** Input failed schema validation at a trust boundary. */
export class ValidationError extends AppError {
  override readonly code = ErrorCode.VALIDATION;
  override readonly httpStatus = 400;
  override readonly publicMessage: string;
  readonly issues: readonly FieldIssue[];

  constructor(message: string, issues: readonly FieldIssue[] = [], options: AppErrorOptions = {}) {
    super(message, options);
    this.issues = issues;
    this.publicMessage = message;
  }

  /**
   * Field issues ARE returned to the client — unlike every other error type's
   * details. This is safe because they describe the caller's own submission,
   * and necessary because forms need to point at the offending field.
   */
  override toPublicJSON(correlationId?: string): PublicErrorBody {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(this.issues.length > 0 ? { issues: this.issues } : {}),
      },
    };
  }
}

/**
 * The caller is not authenticated, or their credentials are wrong.
 *
 * The public message is deliberately uninformative and IDENTICAL for every
 * cause. "No account with that email" would let an attacker enumerate valid
 * accounts, which turns a password-guessing problem into a targeted-phishing
 * list. See docs/security/threat-model.md.
 */
export class AuthenticationError extends AppError {
  override readonly code = ErrorCode.AUTHENTICATION;
  override readonly httpStatus = 401;
  override readonly publicMessage = 'Email or password is incorrect.';
}

/**
 * The caller is authenticated but not permitted.
 *
 * Returns 403 with no detail about whether the target resource exists —
 * distinguishing "forbidden" from "not found" across a tenant boundary would
 * confirm the existence of another workspace's data.
 */
export class AuthorizationError extends AppError {
  override readonly code = ErrorCode.AUTHORIZATION;
  override readonly httpStatus = 403;
  override readonly publicMessage = 'You do not have access to this resource.';
}

export class NotFoundError extends AppError {
  override readonly code = ErrorCode.NOT_FOUND;
  override readonly httpStatus = 404;
  override readonly publicMessage = 'The requested resource was not found.';
}

/** The request conflicts with current state (duplicate, version mismatch). */
export class ConflictError extends AppError {
  override readonly code = ErrorCode.CONFLICT;
  override readonly httpStatus = 409;
  override readonly publicMessage: string;

  constructor(
    message: string,
    publicMessage = 'That action conflicts with the current state.',
    options: AppErrorOptions = {},
  ) {
    super(message, options);
    this.publicMessage = publicMessage;
  }
}

export class RateLimitError extends AppError {
  override readonly code = ErrorCode.RATE_LIMIT;
  override readonly httpStatus = 429;
  override readonly publicMessage = 'Too many attempts. Try again in a few minutes.';

  /** Seconds until the caller may retry; rendered as the `Retry-After` header. */
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, options: AppErrorOptions = {}) {
    super(message, options);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A third-party dependency failed. Distinguished from InternalError so that
 * dashboards can separate "our bug" from "their outage" — the two have
 * completely different responses.
 */
export class IntegrationError extends AppError {
  override readonly code = ErrorCode.INTEGRATION;
  override readonly httpStatus = 502;
  override readonly publicMessage = 'An external service is unavailable. Try again shortly.';

  readonly integration: string;

  constructor(integration: string, message: string, options: AppErrorOptions = {}) {
    super(message, options);
    this.integration = integration;
  }
}

/** An unexpected failure. Non-operational: someone should look at this. */
export class InternalError extends AppError {
  override readonly code = ErrorCode.INTERNAL;
  override readonly httpStatus = 500;
  override readonly publicMessage = 'Something went wrong on our end. Try again.';
  override readonly isOperational = false;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Coerce an unknown thrown value into an AppError.
 *
 * Used at transport boundaries so that a stray `throw 'oops'` or a driver
 * exception still produces a well-formed, non-leaking response. The original
 * value is preserved as `cause` for the log record.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new InternalError(message, { cause: error });
}
