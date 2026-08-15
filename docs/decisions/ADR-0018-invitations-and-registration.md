# ADR-0018 — Invitation-only access; registration deferred

**Status:** Accepted
**Date:** 2026-08-15

## Context

Stage 1 shipped with seeded accounts only. Stage 2 introduces multi-person
workspaces, so a second person must be able to gain access. Two questions:
how do people join, and should anyone be able to self-register?

## Decision

### 1. Invitation-only. No public registration in Stage 2.

Access is granted by an existing member with
`workspace:members:invite`. Self-service workspace creation is **deliberately
not built**.

**Why:** every route that creates a tenant is an unauthenticated resource-
creation endpoint — a spam, abuse and cost vector that needs email
verification, bot defence and rate limiting _at the tenant level_ to be safe.
None of those exist yet. Growth OS is also sold with onboarding today, so
self-serve signup has no customer waiting for it.

Recorded explicitly so that "we forgot" and "we decided" are distinguishable,
and so nobody adds an unprotected `POST /api/auth/register` believing it was
merely an oversight.

### 2. Invitation token design

| Property   | Choice                                             | Reason                                                                                 |
| ---------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Entropy    | 32 bytes, base64url                                | Not guessable                                                                          |
| At rest    | `SHA-256(HMAC(token, SESSION_SECRET))`             | Same construction as sessions — a read-only database leak yields no usable invitations |
| Expiry     | 7 days                                             | Bounds the window if a link is forwarded or leaks from an inbox                        |
| Single use | `accepted_at` set inside the accepting transaction | Prevents a forwarded link creating a second membership                                 |
| Revocable  | `revoked_at`                                       | An invite sent to the wrong address must be killable                                   |
| Scope      | One workspace, one role                            | Cannot be replayed against another tenant                                              |

### 3. An inviter cannot grant more than they hold

`admin` may invite `admin`, `member`, `viewer` — never `owner`. Without this
rule, `members:invite` is a silent privilege-escalation path to workspace
ownership. Enforced by role rank comparison in the service and covered by a
negative test.

### 4. Public behaviour is enumeration-safe

`GET /api/invitations/:token` returns an identical response shape for an
invalid, expired, revoked and already-accepted token. Distinguishing them would
confirm that a workspace exists and that a given address was invited to it.

### 5. Email sending is behind an interface, not implemented

No transactional email provider exists. `InvitationNotifier` is defined;
`ConsoleInvitationNotifier` logs the acceptance URL in development.

**Production refuses to boot with the console notifier** — a silent no-op
notifier in production means invitations that are created, never delivered, and
never noticed.

### 6. Password reset uses the same machinery, and is deferred with it

Identical token design. It is **not implemented** in Stage 2 because without an
email provider it is either useless or an account-takeover vector (a reset link
surfaced anywhere other than the owner's inbox). Named as the first task of the
email-provider stage.

### 7. MFA is deferred, explicitly

TOTP with encrypted secrets, hashed single-use recovery codes, and an
`mfa_pending` session state that grants no access until challenge. **Not
started.** Stage 2 chose CRM delivery and CSP over MFA. Stated so it is not
mistaken for an oversight; SMS-only MFA is ruled out permanently.

## Alternatives considered

### A — Self-service registration now

**Rejected:** unauthenticated tenant creation without email verification, bot
defence or per-tenant rate limiting. No customer is waiting for it.

### B — Magic-link invitations that also authenticate

_Attractive:_ one flow, no password for new users.

**Rejected:** conflates invitation with authentication. A forwarded email would
grant a session, not just an invitation. Accepting an invite must still require
authenticating as the account that accepted it.

### C — Store invitation tokens in plaintext

**Rejected:** a database leak would yield working invitations to every pending
workspace. Same reasoning as session tokens.

### D — Implement password reset without email

**Rejected:** the reset link would have to be surfaced somewhere other than the
owner's inbox, which is an account-takeover vector, not a feature.

## Consequences

### Positive

- Multi-person workspaces work, with a genuinely safe token design.
- No unauthenticated tenant-creation surface.
- Privilege escalation through invitations is closed and tested.

### Negative

- No self-serve signup — a commercial limitation, accepted for now.
- Invitations must be delivered manually in development.
- Password reset and MFA remain absent. Both are stated in the README's
  limitations, not hidden.

## Revisit when

- A transactional email provider is chosen → password reset ships immediately.
- Self-serve is a commercial requirement → needs verification, bot defence and
  tenant-level rate limiting, designed together.

## Related

- [security/authentication.md](../security/authentication.md)
- [ADR-0004](ADR-0004-authentication.md), [ADR-0009](ADR-0009-rate-limiting.md)
