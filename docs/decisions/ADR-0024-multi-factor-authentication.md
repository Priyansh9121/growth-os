# ADR-0024 — MFA: TOTP first, passkeys next, SMS never

**Status:** Accepted (decision made; implementation gated)
**Date:** 2026-08-15

## Context

[ADR-0018](ADR-0018-invitations-and-registration.md) §7 deferred MFA without
deciding what it would eventually be. Stage 2.5 makes the CRM safe for real
customer data, and MFA is the control that stops a single stolen password
turning into a full customer database. The decision cannot keep being deferred
shapeless — a deferred decision with no target design is how a subsystem gets
bolted on badly under time pressure.

This ADR decides the **design and the gate**. It does not ship the code.

## Decision

### 1. TOTP (RFC 6238) is the first factor added

Authenticator-app codes. Chosen over the alternatives for this segment:

| Option                              | Verdict                                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TOTP**                            | **Chosen first.** No delivery dependency, no per-message cost, works offline, universally supported by free authenticator apps                                                                                                                |
| Passkeys / WebAuthn                 | Strongly preferred _eventually_ — phishing-resistant in a way TOTP is not. Deferred because account recovery for a customer who loses their only device is a genuinely hard problem, and getting it wrong locks a business out of its own CRM |
| Email magic-link as a second factor | Not a second factor. If the password was phished, the email account is usually the next thing phished; and it collapses to one factor whenever the browser is already signed into that mailbox                                                |
| **SMS**                             | **Ruled out as a primary design, permanently.** SIM-swap is a routine attack against small-business owners, delivery is unreliable, and it carries a per-message cost that scales with logins                                                 |

SMS is not merely deprioritised. It is not on the roadmap as a primary factor.

### 2. Secrets are encrypted at rest, not merely hashed

A TOTP secret cannot be hashed — the server must reproduce the code, so it needs
the plaintext. It is therefore encrypted with AES-256-GCM under a key derived
from a **dedicated** `MFA_ENCRYPTION_KEY`, separate from `SESSION_SECRET`.

Separate because the two have different blast radii: leaking `SESSION_SECRET`
lets an attacker forge session lookups against a database they already hold;
leaking a key that also decrypts TOTP secrets would additionally defeat the
second factor. Key separation is what keeps one compromise from being both.

### 3. Enrolment is confirmed before it is trusted

The secret is stored `pending` until the user submits a valid code from it.
Enrolling without proving the authenticator actually works locks people out of
their own account on next login — the most common way MFA rollouts fail.

### 4. Recovery codes: ten, single-use, hashed, shown once

Hashed with Argon2id like passwords, because they are password-equivalent
credentials. Displayed exactly once at enrolment. Regenerating invalidates the
previous set.

Without recovery codes, a lost phone means a support-mediated MFA reset — a
social-engineering path that is frequently weaker than the MFA it bypasses.

### 5. A pending session grants nothing

Password verification issues a session in state `mfa_pending` that carries **no
workspace access at all**. It is not a normal session with a flag: a flag is one
missed check away from full access, whereas a session that resolves to zero
memberships fails closed everywhere by construction.

The pending state expires in 10 minutes and cannot be extended.

### 6. Step-up for destructive actions

Once MFA exists, re-authentication is required within a short window for:
member removal, role changes, **contact erasure** ([ADR-0020](ADR-0020-privacy-erasure.md)),
bulk export, and billing changes.

Erasure is on that list deliberately — it is irreversible, and an attacker with
a stolen session could use it destructively rather than for theft.

### 7. Per-workspace enforcement, owner-controlled

An agency operating 40 workspaces cannot force MFA on its clients' staff, and a
business owner should be able to require it of their own. Enforcement is a
workspace setting; the owner enabling it must already have MFA enrolled, or they
lock themselves out immediately.

### 8. The gate for implementation

MFA ships **before the first production tenant that is not us**. That is a
concrete, checkable condition, not "later".

It is deliberately _not_ gated on Stage 2.5 finishing, because MFA without
password reset is a worse product than either alone: MFA multiplies the ways an
account can become unreachable, and reset is the pressure valve. Password reset
(Stage 2.5) comes first; MFA follows on the same email infrastructure.

## Why decide now and build later

Three things in Stage 2.5 would have to be reworked if the MFA shape were still
undecided: the session state model, the capability checks around erasure, and
the `AuthNotifier` seam that password reset introduces. Deciding now means those
three are built compatible with MFA the first time. Building now would mean
shipping a second factor with no reset path, which is how support-mediated
lockout resets — the weakest link — become normal.

## Consequences

### Positive

- The shape is fixed, so Stage 2.5's session and notifier work is built to fit.
- SMS is closed off before someone proposes it as the quick option.
- The gate is a condition, not a date.

### Negative

- **Accounts are single-factor until then.** Real, and mitigated only partly by
  Argon2id, rate limiting, opaque revocable sessions and invitation-only access.
  Stated in the README's honest-limitations section, not buried here.
- Passkeys may well be the better answer by the time this is built. If so, this
  ADR is superseded rather than followed — a decision recorded is not a decision
  that outranks better evidence.

## Revisit when

- A transactional email provider is chosen → reset ships, MFA becomes buildable.
- A prospective customer requires MFA → the gate moves forward.
- Passkey recovery UX matures enough to skip TOTP entirely.

## Related

- [ADR-0004](ADR-0004-authentication.md) · [ADR-0018](ADR-0018-invitations-and-registration.md)
- [ADR-0020](ADR-0020-privacy-erasure.md) — why erasure is a step-up action
- [security/authentication.md](../security/authentication.md)
