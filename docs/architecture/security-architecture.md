# Security Architecture

**Status:** Stage 1 implemented; later layers marked.
**Detail:** [threat model](../security/threat-model.md) ·
[authentication](../security/authentication.md) ·
[tenant isolation](../security/tenant-isolation.md)

## Controls by layer

| Layer              | Control                                                                                    | State                                 |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| **Transport**      | HTTPS enforced in production (env validation refuses http)                                 | ✅                                    |
|                    | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` | ✅                                    |
|                    | Content-Security-Policy                                                                    | ⬜ Stage 2 — needs per-request nonces |
|                    | HSTS                                                                                       | ⬜ At deployment                      |
| **Edge**           | Cookie-presence routing (**not** an authorization boundary)                                | ✅                                    |
|                    | Rate limiting, DDoS absorption at the CDN                                                  | ⬜ Stage 22                           |
| **Request**        | Zod validation at every boundary                                                           | ✅                                    |
|                    | CSRF origin check, failing closed                                                          | ✅                                    |
|                    | Correlation IDs, pattern-restricted                                                        | ✅                                    |
| **Authentication** | Argon2id, opaque sessions, fixation defence, enumeration parity                            | ✅                                    |
|                    | MFA, SSO                                                                                   | ⬜ Stages 2 / 16                      |
| **Authorization**  | Capability matrix; `requireWorkspaceAccess` returns a `TenantActor` services require       | ✅                                    |
| **Data**           | `withTenantTransaction` + RLS with `FORCE`                                                 | ✅                                    |
|                    | Restricted, non-superuser database role                                                    | ✅ documented + test-asserted         |
|                    | Envelope encryption for integration credentials                                            | ⬜ Stage 5                            |
| **AI**             | Typed tools; capability + autonomy + budget + schema guards                                | ✅                                    |
|                    | Prompt-injection handling for untrusted content                                            | ⬜ Stage 7                            |
| **Audit**          | Append-only, RLS-scoped, centrally redacted                                                | ✅                                    |
| **Egress**         | Network restriction for the crawler (SSRF containment)                                     | ⬜ Stage 3                            |

## The three properties that matter most

1. **Tenant isolation is defended three times**, each layer assuming the others
   may fail — and tested as a negative at two of them.
2. **Deterministic code owns state.** An AI proposal is not a state change until
   a service authorizes it and the database commits it.
3. **Uniform failure.** Authentication and authorization errors are identical
   across causes, in body and in timing, so neither becomes an oracle.

## Where a control is deliberately absent

Recorded so absence reads as a decision, not an oversight:

- **`style-src-attr 'unsafe-inline'`.** A bounded relaxation for inline style
  _attributes_ (the entrance choreography and R3F's canvas sizing). It permits
  attributes only, not inline `<style>` elements, and an inline style attribute
  cannot execute JavaScript. **`script-src` is not weakened** — full analysis in
  [ADR-0017](../decisions/ADR-0017-content-security-policy.md).
- **No public registration.** Deliberate, not an oversight: an unauthenticated
  tenant-creation endpoint needs email verification, bot defence and
  tenant-level rate limiting to be safe ([ADR-0018](../decisions/ADR-0018-invitations-and-registration.md)).
- **GDPR erasure is not implemented.** Soft delete is a product feature, not
  erasure. Named prerequisite before the first real customer.
- **No distributed rate limiting.** Correct at one instance; a named **release
  gate** before scaling ([ADR-0009](../decisions/ADR-0009-rate-limiting.md)).
- **Sessions are not bound to IP or User-Agent.** Both are spoofable and mobile
  IPs change legitimately — binding produces false logouts without stopping an
  attacker who already holds the cookie.
- **No WAF.** Belongs at the edge, with deployment.

## Assurance

Automated: the full suite (counts in the Stage 2 report), most security tests
asserting **denials**; contrast checked in CI; three meta-verifiers that test
the checks themselves; and a browser E2E suite that asserts the CSP header,
nonce uniqueness, absence of `'unsafe-inline'` in `script-src`, and zero CSP
violations at runtime.

Manual: flows exercised live and recorded in
[development-log/0005](../development-log/0005-verification-and-measurement.md)
and [0008](../development-log/0008-stage-2-security-and-verification.md).

Not yet: external penetration test, dependency scanning beyond `npm audit`,
SAST. All required before public launch.
