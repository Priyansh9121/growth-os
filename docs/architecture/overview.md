# Architecture Overview

**Status:** Living document
**Last reviewed:** 2026-08-15
**Governing ADRs:** [0001](../decisions/ADR-0001-architecture-style.md),
[0002](../decisions/ADR-0002-monorepo-and-package-strategy.md)

---

## 1. Shape: a modular monolith with pre-cut seams

Growth OS is one deployable application composed of independent domain packages
with enforced dependency rules.

```
┌──────────────────────────────────────────────────────────────────────┐
│  DELIVERY (runtime hosts)                                            │
│                                                                      │
│   apps/web            apps/api ⬜        apps/worker ⬜   apps/voice ⬜│
│   Next.js             Fastify            BullMQ          Python      │
│   UI + route          Public API,        Crawls, jobs,   Realtime    │
│   handlers            webhooks           schedules       voice       │
└───────┬──────────────────┬──────────────────┬───────────────┬────────┘
        │                  │                  │               │ HTTP
        ▼                  ▼                  ▼               │ (typed
┌──────────────────────────────────────────────────────────┐  │ contract)
│  DOMAIN (framework-agnostic packages)                    │◀─┘
│                                                          │
│   @growth-os/auth        sessions, authorization         │
│   @growth-os/contracts   schemas, errors, AI tool spec   │
│   ⬜ @growth-os/seo, /crm, /calendar, /automation, /ai   │
└───────────────────────┬──────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│  PLATFORM                                                │
│   @growth-os/database   schema, migrations, tenant txn   │
│   @growth-os/ui         design system (delivery-side)    │
└───────────────────────┬──────────────────────────────────┘
                        ▼
              PostgreSQL  ·  ⬜ Redis  ·  ⬜ Object storage
```

⬜ = designed, not built. Only `apps/web`, `@growth-os/auth`,
`@growth-os/contracts`, `@growth-os/database` and `@growth-os/ui` exist today —
per Principle 13, we do not create empty packages to match a diagram.

## 2. Why a modular monolith

The full reasoning is in
[ADR-0001](../decisions/ADR-0001-architecture-style.md). In short:

- The dominant early risk is **finding product-market fit for the join**, not
  scaling. Distributed systems tax exactly the thing we need most: fast,
  cross-cutting changes that touch SEO, CRM and attribution together.
- The join is inherently **transactional and relational**. Attribution requires
  joining rankings, sessions, calls, deals and revenue. Splitting these across
  services replaces a `JOIN` with a distributed consistency problem for no
  present benefit.
- **Seams, not services.** Domain logic lives in packages with no framework or
  transport dependencies. When a workload genuinely needs its own runtime
  (crawling, voice), it gets a new host in `apps/` that imports the same
  packages. Extraction is then a deployment change, not a rewrite.

The first extractions are already known: `apps/worker` at Stage 3 (crawling is
CPU/IO-heavy, bursty, and must be network-isolated for SSRF containment) and
`apps/voice` at Stage 13 (Python, realtime, entirely different runtime profile).

## 3. Layering rules

```
apps/*        may import  packages/*
packages/*    may import  packages/*   (only per the allowed edges below)
packages/*    may NEVER import apps/*
```

Allowed package edges — anything else is a lint error:

```
ui         → (nothing internal)
contracts  → (nothing internal)
database   → contracts
auth       → contracts, database
```

**Enforcement is mechanical, not cultural:** `eslint-plugin-boundaries` in
[`eslint.config.mjs`](../../eslint.config.mjs) fails the build on a violation.
An architecture rule that is only written down is a rule that will be broken.
See [module-boundaries.md](module-boundaries.md).

## 4. Request path (as built)

A protected page request:

```
Browser
  │  Cookie: gos_session=<opaque token>
  ▼
proxy.ts ───────── no cookie ──▶ 302 /login?next=<validated relative path>
  │  (cookie presence check only — no DB access at the edge)
  ▼
React Server Component
  ▼
requireActor()                    apps/web/src/server/auth-context.ts
  ▼
validateSession(token)            @growth-os/auth
  │  SHA-256(HMAC(token)) → sessions lookup
  │  idle + absolute expiry check, sliding refresh
  ▼
resolveActor(userId)              memberships + agency memberships → Actor
  ▼
requireWorkspaceAccess(actor, id) capability check for the active workspace
  ▼
withTenantTransaction(id, fn)     SET LOCAL app.workspace_id = id
  ▼                               → RLS policies constrain every statement
PostgreSQL
```

Two properties matter here:

1. **The edge proxy never queries the database.** It performs a cookie-presence
   check to redirect unauthenticated navigation cheaply. It is a UX
   optimisation, _not_ a security control — every authorization decision is
   made in the server component or route handler, where the session is actually
   validated. Treating edge middleware/proxy as an authorization boundary is a common
   and serious Next.js mistake; we deliberately do not.
2. **Authorization is checked before the query, and again by the database.**
   See [../security/tenant-isolation.md](../security/tenant-isolation.md).

## 5. Where state lives

| State                        | Home                        | Notes                                                                                                                                                      |
| ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity, tenancy, sessions  | PostgreSQL                  | Source of truth                                                                                                                                            |
| Audit trail                  | PostgreSQL (`audit_events`) | Append-only                                                                                                                                                |
| Login rate limits            | In-process memory           | ⚠️ Per-instance today; correct only at single-instance scale. Interface exists for a Redis driver — see [ADR-0009](../decisions/ADR-0009-rate-limiting.md) |
| Login → dashboard transition | React context, in-memory    | Deliberately **not** persisted; a refresh must not replay the entrance                                                                                     |
| Demo dashboard values        | Static fixtures in source   | Labelled as fixtures in the UI                                                                                                                             |

## 6. Not built, but designed for

These are load-bearing decisions about the _future_ shape, recorded now so the
foundation does not preclude them:

- **Event backbone** — a transactional outbox in PostgreSQL feeding an
  in-process bus, later a queue. Chosen over direct cross-module calls so that
  attribution can consume everything without every module knowing about it.
  See [event-architecture.md](event-architecture.md).
- **Background workers** — `apps/worker` with BullMQ on Redis (Stage 3).
- **Public API and webhooks** — `apps/api` on Fastify (Stage 21). Route handlers
  in `apps/web` are already thin adapters over domain services precisely so this
  extraction is mechanical.
- **Voice service** — HTTP + signed webhooks to a separate Python system. See
  [voice-architecture.md](voice-architecture.md).
- **AI agent runtime** — tool registry over application services, with autonomy
  levels and budgets. The contract exists today
  ([`packages/contracts/src/ai`](../../packages/contracts/src/ai)); no model is
  connected. See [ai-agent-architecture.md](ai-agent-architecture.md).

## 7. Cross-cutting invariants

Violating any of these is a defect regardless of tests passing:

1. **No entity carries `user.workspace_id`.** Access is via `memberships` only.
2. **Every tenant table has `workspace_id`, an index on it, and an RLS policy.**
3. **No AI-originated value reaches the database without passing a typed tool,
   an application service and schema validation.**
4. **No credential or session token is ever logged.** Redaction is centralised
   in the logger, not left to call sites.
5. **Every external input is validated at the boundary with Zod** — request
   bodies, query params, webhooks, environment variables, third-party responses.
6. **Errors crossing the wire are typed and safe** — no stack traces, no
   database messages, correlation ID only. See
   [../engineering/error-handling.md](../engineering/error-handling.md).

## 8. Known architectural debt

Recorded honestly rather than discovered later:

| Debt                                                    | Impact                                                                              | Trigger to fix                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Rate limiting is in-process                             | Ineffective across multiple instances                                               | Before running >1 web instance                                                               |
| No transactional outbox yet                             | Cross-module reactions would be direct calls                                        | Stage 12 (automation)                                                                        |
| RLS applies to `audit_events` only                      | Other tenant tables do not exist yet; the pattern must be applied as they are added | Every new tenant table (checklist in [tenant-isolation.md](../security/tenant-isolation.md)) |
| Sessions are validated on every request without caching | Extra query per request                                                             | When measurement shows it matters — not before                                               |
| No email transport                                      | Password reset and invitations cannot ship                                          | Stage 2                                                                                      |
