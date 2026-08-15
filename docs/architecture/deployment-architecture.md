# Deployment Architecture

**Status:** ⬜ **NOT DEPLOYED.** No hosting decision has been made.
**Target:** Stage 22 for production hardening; a staging environment sooner.

Stated plainly rather than described as though it exists.

## What runs today

Local development only: `npm run dev` plus a PostgreSQL instance.

## Requirements a hosting choice must satisfy

| Requirement                             | Why                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Node ≥ 22 with **native modules**       | `@node-rs/argon2` is a Rust binding — pure-edge runtimes cannot run it |
| PostgreSQL ≥ 16 with connection pooling | RLS is load-bearing; pooling must preserve `SET LOCAL` semantics       |
| Secrets manager                         | No secret in an image or a build artefact                              |
| **Egress control**                      | Stage 3 SSRF containment for the crawler                               |
| Long-running processes                  | Stage 13 voice sessions do not fit a request/response model            |
| Australian region option                | Initial customer base; residency may become a requirement              |

The pooling requirement is the sharp one: a transaction-mode pooler that
recycles connections mid-transaction would break `SET LOCAL` and silently
disable tenant isolation. Any pooler must be verified against the isolation
test suite, not assumed.

## Planned topology

```
        CDN / WAF
            │
      ┌─────┴─────┐
      ▼           ▼
   web (n)     worker (n)          voice (Python, separate)
      │           │                        │
      └─────┬─────┘                        │
            ▼                              │
      PostgreSQL primary ◀─────────────────┘
            │
       read replica (reporting)
            │
      Redis (jobs, rate limits)
```

## Environments

| Environment | Purpose        | Data                                                  |
| ----------- | -------------- | ----------------------------------------------------- |
| Local       | Development    | Seeded fixtures                                       |
| CI          | Gates          | Ephemeral PostgreSQL                                  |
| Staging     | Pre-production | Anonymised or synthetic — **never a production copy** |
| Production  | Live           | Real customer data                                    |

## Release gates

Before **any** production deployment:

- [ ] `npm run verify:all` passes
- [ ] Migrations reviewed and applied as the owner role
- [ ] **The application connects as a non-superuser, non-owner role**
- [ ] `SESSION_SECRET` is not the placeholder (env validation enforces this)
- [ ] `APP_URL` is https (env validation enforces this)

Before **horizontal scaling**:

- [ ] **Distributed rate limiting implemented** — the in-process limiter is
      per-instance and would silently multiply the effective limit by N

Before **public launch**:

- [ ] CSP with nonces · external penetration test · backup restore rehearsed ·
      data export and deletion flows · incident response documented

## Migrations

Run as a separate step before the application starts, using the **owner** role
and a dedicated connection. Forward-only. Expand-then-contract for breaking
changes, so a rollback of application code never meets a schema it cannot read.

## Not yet decided

Hosting provider · CDN · region and residency · observability stack ·
autoscaling policy · disaster-recovery targets. Each needs its own ADR when
the requirement is real rather than anticipated.
