# ADR-0009 — In-process rate limiting behind a driver interface

**Status:** Accepted
**Date:** 2026-08-15

## Context

Login must resist credential stuffing and password brute force. Later, AI and
voice endpoints will need cost-abuse limits. Today Growth OS runs as a single
web instance and Redis is not part of the stack ([ADR-0001](ADR-0001-architecture-style.md):
do not add infrastructure ahead of a requirement).

## Decision

A `RateLimiter` interface in `@growth-os/auth` with a **sliding-window
in-process implementation** as the only driver today.

Login is limited on two independent keys, both of which must pass:

| Key                        | Limit | Window | Purpose                                             |
| -------------------------- | ----- | ------ | --------------------------------------------------- |
| `login:ip:<ip>`            | 20    | 15 min | Blunts distributed spraying from one source         |
| `login:id:<sha256(email)>` | 8     | 15 min | Protects a specific account regardless of source IP |

Notes on the design:

- The identifier key is **hashed**, so the limiter's keyspace never holds
  plaintext email addresses in memory or in a future Redis instance.
- Counters are consumed on **failed** attempts and reset on success, so a
  legitimate user who signs in correctly is never penalised for someone else's
  attempts against a shared IP.
- Responses do not reveal which limit tripped, and a limited request returns the
  same generic failure shape as a wrong password, with `Retry-After`.
- Client IP is derived from the platform-provided address, and from
  `X-Forwarded-For` **only** when `TRUSTED_PROXY` is configured — an unvalidated
  `X-Forwarded-For` is attacker-controlled and would make per-IP limiting
  trivially bypassable.

## Alternatives considered

### A — In-process sliding window (chosen)

_Why:_ zero new infrastructure, zero network latency in the auth path, and it is
genuinely effective at the current topology (one instance).

_Cost:_ **the limit is per instance.** With N instances the effective limit is
N× the configured value, and a restart clears all counters. This is a real
limitation, recorded as known debt in
[architecture/overview.md](../architecture/overview.md#8-known-architectural-debt).

### B — Redis-backed limiter now

_Attractive because:_ correct across instances from day one; survives restarts.

**Rejected because:** it introduces a required piece of infrastructure — and a
new failure mode in the authentication path (what happens when Redis is
unreachable? fail open, and the limiter is theatre; fail closed, and Redis
becomes a single point of failure for sign-in) — before we run more than one
instance. The interface exists so this is a driver swap, not a rewrite.

### C — Database-backed counters

**Rejected because:** a write to PostgreSQL on every login attempt, including
attacker traffic, turns the rate limiter into an amplification vector against
our primary datastore.

### D — Edge/CDN rate limiting only

_Attractive because:_ absorbs volumetric attacks before they reach the app.

**Rejected as the sole mechanism because** it cannot express per-identifier
limits (it does not know the email in the body), and it ties a security control
to a hosting provider. It is complementary and should be added at Stage 22.

### E — Account lockout after N failures

**Rejected because:** it converts a brute-force attempt into a denial-of-service
against a known email address. Throttling degrades the attack without letting an
attacker lock a customer out of their own account.

## Consequences

### Positive

- No infrastructure dependency in the authentication path.
- No network round trip added to sign-in.
- Swapping drivers is a one-line change at the composition root.

### Negative

- **Incorrect above one instance** — this must be fixed _before_ horizontal
  scaling, not after. The trigger is named below.
- Counters are lost on restart.
- Memory grows with distinct keys; bounded by a periodic sweep and a maximum
  entry count with LRU eviction.

### Risks and mitigations

| Risk                                            | Mitigation                                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed to multiple instances without noticing | Recorded as known debt; named as a **release gate** for horizontal scaling; the driver is selected by `RATE_LIMIT_DRIVER` so the gap is visible in configuration |
| Memory exhaustion from key churn                | Max-entry cap with eviction plus expiry sweep                                                                                                                    |
| Spoofed `X-Forwarded-For` bypasses the IP limit | Header trusted only behind an explicitly configured proxy                                                                                                        |

## Revisit when

- **Before** running more than one web instance → implement the Redis driver.
- AI or voice endpoints ship → they need cost-based limits (tokens/minutes), not
  request counts; that is a distinct limiter with the same interface.

## Related

- [security/authentication.md](../security/authentication.md)
- [security/threat-model.md](../security/threat-model.md)
