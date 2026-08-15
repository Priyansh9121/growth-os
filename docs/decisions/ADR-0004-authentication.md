# ADR-0004 — First-party session authentication

**Status:** Accepted
**Date:** 2026-08-15
**Context as of this date:** No users. Two customer shapes (direct business,
agency). One user must be able to access many workspaces. Future requirements
already visible: invitations, MFA, SSO for agencies, impersonation for support.

## Context

Authentication is the highest-consequence subsystem we will write, and the one
where being _unoriginal_ is a virtue. The requirements:

1. Email + password now; MFA, SSO and invitations later without a rewrite.
2. **Sessions must be revocable server-side**, immediately — an agency removing
   a departing employee's access cannot wait for a token to expire.
3. **A session identifies a user, not a workspace.** Workspace switching must
   not require re-authentication (P2 operates 40 workspaces).
4. Every authentication event must be auditable per workspace.
5. It must run in Next.js server components and route handlers, and later in a
   separate Fastify host, unchanged.

## Decision

**First-party, database-backed opaque session authentication.**

| Element          | Choice                                                                                                           | Rationale                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing | **Argon2id** via `@node-rs/argon2` — m=19456 KiB, t=2, p=1                                                       | OWASP-recommended parameters; memory-hard; native Rust binding avoids the C++ build fragility of `node-argon2`                                                                                                  |
| Session token    | 32 bytes from `crypto.randomBytes`, base64url                                                                    | 256 bits of entropy — brute force is not a threat model                                                                                                                                                         |
| Token at rest    | `SHA-256(HMAC-SHA256(token, SESSION_SECRET))` stored; raw token never persisted                                  | A read-only database leak yields no usable tokens without the application secret. Fast hashing is correct here: the input is already high-entropy, so slow hashing buys nothing and costs a per-request penalty |
| Transport        | `httpOnly`, `Secure` (non-local), `SameSite=Lax`, `Path=/` cookie                                                | `httpOnly` defeats XSS token theft; `Lax` permits top-level navigation while blocking cross-site sub-requests                                                                                                   |
| Lifetime         | Sliding 30-day idle, hard 90-day absolute                                                                        | Idle expiry limits stolen-cookie value; absolute expiry bounds it regardless of activity                                                                                                                        |
| CSRF             | Origin/Referer validation on every state-changing request, plus `SameSite=Lax`                                   | Defence in depth; see below                                                                                                                                                                                     |
| Session fixation | A new token is issued on every successful authentication; any prior session for the same browser is revoked      |                                                                                                                                                                                                                 |
| Rate limiting    | Per-IP and per-identifier sliding window                                                                         | See [ADR-0009](ADR-0009-rate-limiting.md)                                                                                                                                                                       |
| Enumeration      | Identical response and timing for unknown-email and wrong-password (a dummy verify runs when the user is absent) |                                                                                                                                                                                                                 |

**Explicitly rejected mechanics:** JWTs as session tokens, and any token stored
in `localStorage` or non-`httpOnly` cookies.

### Why not JWT sessions

A stateless JWT cannot be revoked before expiry without a revocation list — at
which point it is a database-backed session with extra steps and a larger
attack surface (algorithm confusion, `alg: none`, key rotation, clock skew).
Requirement 2 makes revocation mandatory. We also read the session on nearly
every request anyway to resolve memberships, so the "avoids a database query"
argument does not apply.

### Why CSRF defence beyond SameSite

`SameSite=Lax` blocks the classic cross-site form POST, but it is not sufficient
alone: it does not protect against same-site attacks from a compromised
subdomain, and browser behaviour has varied. Every state-changing request
therefore validates that `Origin` (falling back to `Referer`) matches `APP_URL`,
and **rejects the request when neither header is present**. Failing closed on a
missing origin is deliberate: a missing header on a state-changing request from
a browser is anomalous.

## Alternatives considered

### A — Clerk / WorkOS / Auth0 (hosted identity)

_Attractive because:_ MFA, SSO, social login and a hosted UI arrive
immediately; security is someone else's specialty; SOC 2 evidence comes free.

**Rejected because:**

- **Tenancy mismatch.** Our model is user → membership → workspace, with a
  second transitive path through agencies. Hosted providers impose their own
  organisation model, and bending it to a two-path agency hierarchy means
  fighting the product for the life of the platform.
- **Pricing on MAU is adverse to the agency channel.** Every client workspace
  multiplies seats; the pricing curve directly opposes the go-to-market motion.
- **The login experience is a flagship product surface** (see
  [login-experience.md](../design/login-experience.md)). A hosted widget or a
  redirect to a provider domain forfeits it.
- Vendor lock-in on the one subsystem that is most painful to migrate: you
  cannot export password hashes from most providers.

### B — Auth.js (NextAuth)

_Attractive because:_ open source, Next-native, adapters for Drizzle, provider
ecosystem for later SSO.

**Rejected because:**

- Its session model is user-centric and its callback surface is awkward for
  membership-resolved, workspace-scoped authorization; we would end up
  re-implementing our authorization layer anyway.
- Strong coupling to Next.js works against the pre-committed extraction to a
  Fastify host ([ADR-0001](ADR-0001-architecture-style.md)).
- Its abstractions obscure the exact cookie, rotation and CSRF behaviour — for
  the subsystem where we most need to be able to state precisely what happens.

Auth.js remains a reasonable choice for products without the agency tenancy
shape. It is a poor fit for ours.

### C — Lucia

_Attractive because:_ an excellent fit conceptually — it is essentially this
design, packaged.

**Rejected because:** Lucia was deprecated as a library and repositioned as a
learning resource. Adopting a deprecated dependency for the authentication core
is not defensible. We implement the same well-understood pattern directly.

### D — Supabase Auth

**Rejected because:** it implies adopting Supabase's Postgres and its
`auth.users` model, which conflicts with our own schema ownership and migration
discipline, and couples identity to a hosting choice.

## Consequences

### Positive

- Complete control over the login surface, which is a product differentiator.
- The tenancy model is native rather than adapted.
- Immediate server-side revocation; sessions are inspectable and auditable rows.
- No per-MAU cost as the agency channel grows.
- Portable to any Node host — no framework coupling.

### Negative

- **We own the security of this code.** Mitigated by: sticking to well-trodden
  mechanisms, an explicit threat model, and tests that assert the negative cases
  (enumeration parity, expiry, fixation, cross-tenant denial, origin rejection).
- MFA, SSO, password reset and social login are work we must do, not features we
  can switch on. Sequenced in [product-roadmap.md](../product/product-roadmap.md).
- A database query per authenticated request. Measured, not assumed; caching is
  deferred until a measurement justifies it.

### Risks and mitigations

| Risk                                                 | Mitigation                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A subtle flaw in first-party auth code               | Narrow surface; no bespoke cryptography; negative-path tests; documented threat model; external review before public launch                  |
| `SESSION_SECRET` leak enables forged session lookups | Secret only permits _lookup_ of an existing hash, not minting a valid token; rotation invalidates all sessions and is a documented procedure |
| Session table growth                                 | Expired sessions pruned on read plus a scheduled sweep (Stage 3 worker)                                                                      |

## Revisit when

- An agency requires SAML/OIDC SSO (Stage 16) — evaluate WorkOS **for the SSO
  path only**, keeping first-party sessions as the primary mechanism.
- Passkeys/WebAuthn become the expected default for this customer segment.

## Related

- [security/authentication.md](../security/authentication.md) — implementation detail
- [security/threat-model.md](../security/threat-model.md)
- [ADR-0005](ADR-0005-multi-tenancy-model.md), [ADR-0009](ADR-0009-rate-limiting.md)
