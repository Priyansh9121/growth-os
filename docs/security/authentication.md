# Authentication

**Status:** Implemented (Stage 1)
**Last reviewed:** 2026-08-15
**Governing ADR:** [ADR-0004](../decisions/ADR-0004-authentication.md)
**Implementation:** [`packages/auth/`](../../packages/auth/)

---

## Summary

| Element          | Choice                                                               |
| ---------------- | -------------------------------------------------------------------- |
| Password hashing | Argon2id — m=19456 KiB, t=2, p=1 (OWASP 2024)                        |
| Session token    | 32 bytes from `crypto.randomBytes`, base64url (256 bits)             |
| Token at rest    | `SHA-256(HMAC-SHA256(token, SESSION_SECRET))`                        |
| Transport        | Cookie `gos_session`: httpOnly, Secure (https), SameSite=Lax, Path=/ |
| Lifetime         | Sliding 30-day idle, hard 90-day absolute                            |
| CSRF             | Origin/Referer validation, failing closed                            |
| Rate limiting    | Sliding window on IP **and** hashed identifier                       |
| Revocation       | Immediate, server-side                                               |

---

## The sign-in sequence

Implemented in [`packages/auth/src/login.ts`](../../packages/auth/src/login.ts).
**The order is the security design** — several steps are only correct in this
position.

### 1. Rate limit — before any database read or hash

Argon2 is deliberately expensive (~19 MiB, tens of milliseconds). Limiting
_after_ hashing would let an attacker use the login endpoint to exhaust our CPU
and memory, turning a credential-stuffing attempt into a denial of service
against every other customer.

Two independent keys, both of which must pass:

| Key                        | Default     | Purpose                                  |
| -------------------------- | ----------- | ---------------------------------------- |
| `login:ip:<ip>`            | 24 / 15 min | Blunts spraying from one source          |
| `login:id:<sha256(email)>` | 8 / 15 min  | Protects one account across many sources |

The identifier is **hashed**, so neither process memory nor a future Redis
instance holds a plaintext list of the addresses people are attempting.

### 2. Look up the user

By normalised email. Normalisation (trim + lowercase) happens in
`emailSchema` and is re-applied inside `login()` itself — the package boundary
is a trust boundary, and a caller that forgot to parse would otherwise produce
"correct password rejected", which is miserable to diagnose.

### 3. Verify — with a dummy hash when there is no user

```ts
if (!user || user.passwordHash === null) {
  passwordValid = await verifyPasswordDummy(input.password); // burns equal CPU
} else {
  passwordValid = await verifyPassword(user.passwordHash, input.password);
}
```

**Account enumeration defence.** Returning early on "no such user" would make
that path tens of milliseconds faster, because only the other path runs Argon2.
That difference is measurable over a handful of requests and turns the endpoint
into an oracle for which email addresses have accounts — converting a
password-guessing problem into a targeted phishing list.

A **disabled** account is also treated exactly like a wrong password, and only
_after_ the hash has been computed, so its timing matches too.

Verified live: unknown-email and wrong-password responses are identical apart
from the correlation ID.

### 4. On success, reset only the identifier limit

The IP counter is deliberately **not** reset. A shared IP (an office, a
co-working space, a NAT gateway) must not have its protection cleared by one
legitimate sign-in — otherwise an attacker on that network clears the limit at
will using their own valid credentials.

### 5. Rehash if parameters have been raised

The only moment we legitimately hold the plaintext. Failure is swallowed: a
rehash problem must never deny a valid user access.

### 6. Create a NEW session

**Session fixation defence.** A fresh row and a fresh token on every
authentication. If an attacker planted a session token in the victim's browser
before sign-in, that token is not the one that ends up authenticated.

---

## Session tokens

```
token (in cookie)  →  HMAC-SHA256(token, SESSION_SECRET)  →  SHA-256  →  sessions.token_hash
```

**Why HMAC then SHA-256.** The HMAC binds the stored value to the application
secret, so an attacker with a read-only copy of the database — a leaked backup,
a SQL-injection read, a misconfigured replica — cannot authenticate without
also obtaining `SESSION_SECRET` from a different system. The outer SHA-256
yields a fixed-width hex string suitable for a unique btree index.

**Why not Argon2 here.** Slow hashing exists to make guessing a _low-entropy_
secret expensive. A 256-bit random token cannot be guessed, so a slow hash
would add tens of milliseconds to every authenticated request in exchange for
nothing.

**Rotation.** Changing `SESSION_SECRET` changes every derived hash and
therefore signs everyone out. That is intentional, and is the documented
emergency procedure.

Verified live: the database stores a 64-character hex digest bearing no
relation to the raw cookie value.

### Expiry

- **Idle (30d, sliding)** — refreshed on use, but only once half the window has
  elapsed. Refreshing on every request would mean an UPDATE per authenticated
  request for no security gain.
- **Absolute (90d)** — never extended. Without it, an attacker holding a stolen
  cookie could refresh indefinitely and never be forced out.
- The user's `disabled_at` is checked in the same query, so disabling an account
  takes effect on the next request rather than at session expiry.

Every failure mode — not found, expired, past absolute expiry, disabled user —
returns `null`. The caller cannot distinguish them, and should not.

---

## The cookie

```
gos_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
```

- **HttpOnly** — JavaScript cannot read it, so an XSS payload cannot exfiltrate
  the session. This is why the token is not in `localStorage`.
- **Secure** — derived from whether `APP_URL` is https, _not_ from `NODE_ENV`.
  Tying it to NODE_ENV is a recurring source of "cookies stopped working in
  staging" incidents.
- **SameSite=Lax** — blocks cross-site sub-requests (the CSRF vector) while
  still sending the cookie on top-level navigation, so links from email and
  reports keep you signed in. `Strict` would break that for little gain.

**`__Host-` prefix is not used**, deliberately: it would require https
unconditionally, so the cookie name would differ between local development and
production — and environment-dependent cookie names are a reliable source of
"works on my machine". Revisit when local development runs over TLS.

---

## CSRF

Every state-changing request validates `Origin` (falling back to `Referer`)
against `APP_URL`, and **rejects when neither header is present**.

Browsers send `Origin` on cross-origin requests and on same-origin POSTs, so a
state-changing request with neither header is anomalous. Treating "absent" as
"safe" is how origin checks get bypassed in practice.

This sits _alongside_ `SameSite=Lax` rather than replacing it: SameSite does not
protect against a compromised subdomain (which is same-site), and browser
behaviour has varied across versions.

Verified live: a foreign origin and a missing origin both return 403.

---

## Open redirect

`sanitiseRedirect` accepts only same-origin relative paths, and is applied
server-side. Rejected: absolute URLs, protocol-relative `//host`, backslash
variants, URL-encoded payloads (decoded _before_ checking), `javascript:`, and
control characters. One unit test per attack shape.

---

## What is NOT implemented

Listed so nothing here is mistaken for a complete authentication product.

| Missing                   | Stage          | Note                                                                               |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| Self-serve registration   | 2              | Accounts are seeded or invited                                                     |
| Password reset            | 2              | Needs transactional email                                                          |
| Email verification        | 2              | Column exists; flow does not                                                       |
| MFA / TOTP                | 2              | Design below                                                                       |
| Passkeys / WebAuthn       | TBD            | Likely to overtake TOTP for this segment                                           |
| SSO (SAML/OIDC)           | 16             | Agency requirement; evaluate WorkOS for this path only                             |
| Breached-password check   | 2              | k-anonymity range query against HIBP at password-set time                          |
| Active-sessions UI        | 2              | Data is recorded (`ip_address`, `user_agent`, `last_used_at`)                      |
| Distributed rate limiting | Before scaling | **Release gate** — see [ADR-0009](../decisions/ADR-0009-rate-limiting.md)          |
| Content-Security-Policy   | 2              | Needs per-request nonces; a policy with `'unsafe-inline'` would be worse than none |

### Planned MFA shape

TOTP with encrypted secrets, verified at enrolment; single-use recovery codes
stored hashed; a second session state (`mfa_pending`) that grants no access
until the challenge is met; step-up re-authentication for high-risk actions
(billing, member removal, workspace deletion).

---

## Invitations (Stage 2)

The only way a second person gains access to a workspace.

| Property                     | Choice                                                                                   | Why                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Token                        | 32 bytes, base64url                                                                      | Not guessable                                                                          |
| At rest                      | `SHA-256(HMAC(token, SESSION_SECRET))`                                                   | Same construction as sessions — a read-only database leak yields no usable invitations |
| Expiry                       | 7 days                                                                                   | Bounds the window if a link is forwarded or leaks from an inbox                        |
| Single use                   | `accepted_at` claimed inside the accepting transaction, guarded by `accepted_at IS NULL` | Two simultaneous acceptances produce exactly one membership                            |
| Role cap                     | **An inviter cannot grant a role stronger than their own**                               | Otherwise `members:invite` is a silent path to workspace ownership                     |
| Lookup                       | Identical response for invalid, expired, revoked and used                                | Enumeration-safe                                                                       |
| Accepting an existing member | Keeps the **stronger** role                                                              | Accepting an invite must never downgrade someone                                       |

Delivery is behind an `InvitationNotifier` interface. The development
implementation logs the acceptance URL; **production refuses to construct it**,
because a silent no-op notifier means invitations that are created, never
delivered, and never noticed.

## Testing

| Property                                                                          | Where                    |
| --------------------------------------------------------------------------------- | ------------------------ |
| Argon2id parameters are what we think                                             | `password.test.ts`       |
| Dummy verify takes comparable time to a real one                                  | `password.test.ts`       |
| Malformed hash returns false, does not throw                                      | `password.test.ts`       |
| Rehash detection across parameter changes                                         | `password.test.ts`       |
| Open redirect: 12 attack shapes rejected                                          | `request-guards.test.ts` |
| CSRF: foreign origin, scheme change, subdomain, suffix lookalike, missing headers | `request-guards.test.ts` |
| `X-Forwarded-For` ignored without a trusted proxy                                 | `request-guards.test.ts` |
| Unknown email and wrong password are indistinguishable                            | `auth-login.test.ts`     |
| Disabled account behaves as a wrong password                                      | `auth-login.test.ts`     |
| Rate limit trips, and resets only on success                                      | `auth-login.test.ts`     |
| A new token is issued per sign-in (fixation)                                      | `auth-login.test.ts`     |
| The raw token is never stored                                                     | `auth-login.test.ts`     |
| Audit events written for success and failure                                      | `auth-login.test.ts`     |
| Form a11y: labels, focus return, `aria-busy`, alerts                              | `login-form.test.tsx`    |
