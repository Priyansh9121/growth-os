# 0003 — Database, authentication and multi-tenancy

**Date:** 2026-08-15 · **Stage:** 1

## Objective

Implement the tenancy spine and the authentication system, with isolation
defended at three independent layers.

## Initial state

Strategy and ADRs complete ([0002](0002-strategy-and-architecture.md)). No
runtime code.

## Investigation

Two questions had to be settled before writing schema.

**1. Where does agency access live?** Two options: copy agency access into
`memberships` rows, or resolve it transitively through `workspaces.agency_id`.
Transitive won because detaching a client from an agency becomes a single
nullable-column update rather than a fan-out delete across every agency
employee's membership rows — a fan-out that can partially fail and leave
someone with access they should not have.

**2. Is RLS actually enforced against us?** PostgreSQL exempts superusers
unconditionally and table owners unless `FORCE` is set. This was verified
directly rather than assumed:

```
 relname      | relrowsecurity | relforcerowsecurity
 audit_events | t              | t
```

That check is why the integration harness creates a **restricted, non-owner
role** and calls `assertRestrictedRole` before any isolation assertion.
Connecting as the migration role would have made every isolation test pass
while proving nothing — the worst possible failure mode for a security test.

## Decisions

1. **Seven tables**, not eighty. `users`, `sessions`, `agencies`, `workspaces`,
   `memberships`, `agency_memberships`, `audit_events`. Future domains are
   documented in [data-architecture.md](../architecture/data-architecture.md),
   not stubbed.
2. **`audit_events` is deliberately the first tenant-scoped table.** It
   establishes the RLS pattern every future table copies, on a table whose
   contents are not critical. Learning the pattern for the first time on
   `contacts` would be much more expensive.
3. **The audit trail is append-only by the ABSENCE of a policy.** With RLS
   enabled, an operation with no matching policy is denied. No `UPDATE` or
   `DELETE` policy exists — that is the control.
4. **`requireWorkspaceAccess` returns a `TenantActor`, not a boolean.** Services
   accept a `TenantActor`, and the only way to obtain one is to pass the check,
   so "forgot to authorize" becomes a compile error.
5. **Rate limiting runs before any hash.** Argon2 is deliberately expensive;
   limiting afterwards would let the login endpoint be used to exhaust our own
   CPU.
6. **Redaction is centralised in the audit writer**, not left to call sites. A
   rule of the form "remember not to log the password" is one that will
   eventually be broken.

## Alternatives considered

- **Copying agency access into `memberships`** — rejected, above.
- **Database-backed roles/permissions** — no customer needs custom roles; it
  would add a join to every authorization check plus an admin surface. The
  static matrix is exhaustively type-checked and free at runtime.
- **Binding sessions to IP/User-Agent** — rejected: both spoofable, mobile IPs
  change legitimately, so it causes false logouts without stopping an attacker
  who already has the cookie.
- **Account lockout** — rejected: converts brute force into a denial-of-service
  against a known email address.

## Files created

`packages/contracts/src/` — errors, tenancy (capabilities, actor), auth
schemas, growth metrics, AI tool contract and registry, env validation.
`packages/database/src/` — schema (identity, tenancy, audit), client with
`withTenantTransaction`, redacting audit writer, migrate/seed scripts, test
harness. Two migrations: generated schema, hand-written RLS.
`packages/auth/src/` — password, session store, actor resolution, guards, rate
limiting, HTTP guards, login use case.

## Architecture impact

The tenancy spine. `Actor` is resolved once per request and carried down;
nothing re-queries, which removes a class of time-of-check/time-of-use gaps.

## Security impact

Implemented: three-layer isolation · Argon2id at OWASP parameters · opaque
sessions stored as `SHA-256(HMAC(token))` · session fixation defence ·
enumeration parity via a dummy verify · dual-key rate limiting · CSRF origin
check failing closed · open-redirect defence · centralised redaction.

## Testing

A test failure exposed a real design gap: `login()` assumed its caller had
already normalised the email through the schema. That is an **unstated
precondition on a public package export**, and its failure mode is silent and
miserable — a user whose stored email is `sam@x.test` typing `Sam@X.test` is
told their password is wrong. Fixed by re-normalising inside `login()` using
the same schema, with a comment explaining why the duplication is correct.

Result: 21 integration tests passing, including the full RLS suite against a
restricted role.

## Result

Sign-in works end to end. Cross-tenant access is denied at the application
layer and returns zero rows at the database layer.

## Remaining work

Registration, password reset, MFA, invitations — all Stage 2. Distributed rate
limiting before horizontal scaling.
