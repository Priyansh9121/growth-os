# Error Handling

**Status:** Implemented (Stage 1)
**Implementation:** [`packages/contracts/src/errors/app-error.ts`](../../packages/contracts/src/errors/app-error.ts)

## The taxonomy

Every expected failure is one of these. Transport layers translate an
`AppError` into a response **mechanically** — a route handler never chooses a
status code or composes user-facing wording, because that decision belongs to
the code that knows what went wrong.

| Class                 | Code                   | HTTP | Operational? |
| --------------------- | ---------------------- | ---- | ------------ |
| `ValidationError`     | `validation_error`     | 400  | yes          |
| `AuthenticationError` | `authentication_error` | 401  | yes          |
| `AuthorizationError`  | `authorization_error`  | 403  | yes          |
| `NotFoundError`       | `not_found`            | 404  | yes          |
| `ConflictError`       | `conflict`             | 409  | yes          |
| `RateLimitError`      | `rate_limited`         | 429  | yes          |
| `IntegrationError`    | `integration_error`    | 502  | yes          |
| `InternalError`       | `internal_error`       | 500  | **no**       |

`isOperational` separates "the system worked and the answer is no" from "the
system broke". Alerting keys off it: operational errors are business as usual
and must not page anyone at 3am.

## The security invariant

> **`publicMessage` is the only field that may reach a client.**

`message`, `details`, `cause` and the stack are for logs. This split exists
because the most common way products leak internals — database messages, file
paths, the existence of another tenant's record — is by rendering an exception
verbatim. Making the safe field explicit means the unsafe path requires
deliberate effort.

Two messages are deliberately uninformative:

- `AuthenticationError` — identical for unknown email and wrong password.
  Anything else is an account-enumeration oracle.
- `AuthorizationError` — never reveals whether the resource exists. A 404-vs-403
  distinction across a tenant boundary confirms another workspace's existence.

`ValidationError` is the one exception that returns `details` to the client:
field issues describe the caller's _own_ submission, so they leak nothing, and
forms need them to point at the offending input.

## Correlation IDs

Every response carries `x-growth-request-id`. It appears in the error body, in
every log line for that request, and in `audit_events.correlation_id` — so a
user quoting a reference leads straight to the full record. Inbound values are
honoured (for end-to-end tracing) but length- and pattern-restricted, because
an attacker-controlled value ends up in logs and unbounded input in a log line
is an injection vector.

## Client-side

`app/error.tsx` renders `error.digest` — a server-generated hash — and **never**
`error.message` or the stack. Users get: what happened in plain language, a
retry where retrying could help, and a reference for support.

## Rules

1. Throw a typed `AppError`, never a bare `Error` or a string.
2. Never `catch` and swallow silently. The two deliberate exceptions —
   post-login rehash and the audit writer — are commented with why.
3. Never put a database error message in a response.
4. `toAppError` at every transport boundary, so a stray throw still produces a
   well-formed, non-leaking response.
5. A user-facing message says what happened and what to do next.
