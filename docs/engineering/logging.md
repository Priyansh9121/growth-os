# Logging

**Status:** Conventions defined; structured logger planned for Stage 3.

## Current state — stated honestly

Growth OS uses `console` with structured object payloads. There is **no logging
library yet**, because at one instance with no log aggregator a logger would be
configuration without benefit ([Principle 13](../product/product-principles.md)).

`packages/observability` arrives with `apps/worker` at Stage 3, when there is
genuinely somewhere for logs to go.

## Never log

Non-negotiable. This list is the reason redaction is centralised rather than
left to call sites.

- Passwords, in any form, at any point
- Session tokens (raw or hashed)
- `SESSION_SECRET` or any application secret
- OAuth tokens, refresh tokens, API keys
- Full request bodies from authentication endpoints
- Card or bank details
- Call recording contents (Stage 13)

`redactMetadata` in
[`packages/database/src/audit.ts`](../../packages/database/src/audit.ts)
enforces this for the audit trail: it matches credential-shaped keys as
substrings at any depth, so a caller cannot write a secret into an audit record
even by accident. A rule of the form "remember not to log the password" is a
rule that will eventually be broken by someone adding a field at 5pm.

**Deliberate exception:** a key named exactly `sessionId` passes through. A
session _identifier_ is an opaque UUID, not the token, and it is genuinely
needed to correlate a sign-in with later activity.

## Safe to log

Request ID · workspace ID · user ID (opaque UUID) · event name · duration ·
status code · error code and class · route · outcome.

## Shape

```ts
console.info('[request] handled error', {
  correlationId,
  code,
  name,
  message,
  details,
});
```

A stable prefix (`[request]`, `[security]`, `[audit]`) plus a flat object. When
the structured logger lands, the payload shape carries over unchanged.

## Levels

`trace` SQL statements (never in production) · `debug` development detail ·
`info` normal operations and **operational** errors · `warn` degraded but
handled · `error` non-operational failures, i.e. someone should look.

An expected 401 is `info`, not `error` — otherwise the error rate is dominated
by users mistyping passwords and stops meaning anything.

## Audit events vs logs

Different systems, deliberately.

|           | Audit events                                        | Logs                     |
| --------- | --------------------------------------------------- | ------------------------ |
| Purpose   | _Who did what_ — a business and security record     | Debugging and operations |
| Storage   | PostgreSQL, tenant-scoped, RLS-protected            | Files / aggregator       |
| Retention | Long, policy-driven                                 | Short                    |
| Guarantee | Best-effort today; transactional outbox at Stage 12 | Best-effort              |

An audit write failing must never fail the operation being audited — a user
whose sign-in succeeded should not get a 500 because the audit table was
briefly unavailable.
