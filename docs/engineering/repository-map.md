# Repository Map

**Status:** Current as of 2026-08-15 (Stage 1)
**Governing ADRs:** [0001](../decisions/ADR-0001-architecture-style.md),
[0002](../decisions/ADR-0002-monorepo-and-package-strategy.md)

Every significant directory: what it is for, what it may depend on, what it
must never do, and where its security boundary lies.

**The dependency rule, in one line:** `apps/*` may use any package; packages
may only use the edges listed below; nothing in `packages/` may ever import
from `apps/`. Enforced by ESLint and _verified_ by
`scripts/verify-boundaries.mjs`.

```
                        apps/web
                            │  (may use any package)
     ┌──────────────┬────────┴───────┬──────────────────┐
     ▼              ▼                ▼                  ▼
@growth-os/ui  @growth-os/auth  @growth-os/crm   @growth-os/contracts
                    │                │                  ▲
                    └────────┬───────┘                  │
                             ▼                          │
                    @growth-os/database ────────────────┘
```

`crm` and `auth` are siblings: **`crm` must not import `auth`**. That would
cycle, and would couple the CRM to how authentication happened — which the
voice service (Stage 13) will not share. Capability checks resolve through
`contracts` instead.

---

## `apps/web/`

**Purpose:** The Growth OS web application. Today it is the only runtime host:
it serves the marketing-grade authentication surface, the operator dashboard,
and the HTTP API used by the browser.

**Why separate from packages:** it owns _transport and rendering_, not business
rules. Keeping domain logic out of it is what allows `apps/api` (Fastify) and
`apps/worker` to be added later by importing the same packages rather than
rewriting them.

**Contains**

| Path              | Responsibility                                                              |
| ----------------- | --------------------------------------------------------------------------- |
| `src/app/`        | Next.js App Router: routes, layouts, route handlers                         |
| `src/app/(auth)/` | Unauthenticated surfaces (login)                                            |
| `src/app/(app)/`  | Authenticated surfaces. **Its layout is the authorization gate**            |
| `src/app/api/`    | Route handlers — thin adapters over domain services                         |
| `src/server/`     | Server-only composition: dependencies, auth context, HTTP helpers, AI tools |
| `src/features/`   | Vertical slices with their own state (auth transition, login, growth field) |
| `src/components/` | Shell and dashboard composition                                             |
| `src/lib/`        | Navigation manifest and development fixtures                                |
| `src/proxy.ts`    | Edge routing. **Not** a security boundary                                   |

**May depend on:** every `@growth-os/*` package; Next.js; React.

**Must NOT:** contain business rules that belong in a package; import from
another app; be imported _by_ a package.

**Security boundary:** this is where untrusted input enters. Every route
handler validates with Zod, checks request origin on state-changing methods,
and resolves an `Actor` before touching data. `src/server/*` files import
`server-only`, so importing them from a client component is a build error
rather than a runtime secret leak.

**Testing:** component and accessibility tests (`*.test.tsx`, jsdom); the
transition machine has pure unit tests.

---

## `packages/contracts/`

**Purpose:** The vocabulary every other package speaks — shared types, Zod
schemas, the typed error taxonomy, tenancy roles and capabilities, and the AI
tool contract.

**Why separate:** it must be importable by everything without dragging in I/O.
It performs no database access, no HTTP, no filesystem work.

**Contains:** `errors/` (the `AppError` hierarchy) · `tenancy/` (roles, the
capability matrix, `Actor`) · `auth/` (login schemas) · `growth/` (metric and
opportunity types) · `ai/` (the tool contract and registry) · `env.ts`.

**May depend on:** `zod`. **Nothing internal.**

**Must NOT:** import any other `@growth-os` package, React, Next.js, or a
database driver. Perform I/O — except `env.ts`, which reads `process.env` once
and is therefore exported under a _separate_ entry point so client bundles
cannot pull it in.

**Security boundary:** defines the split between `AppError.message` (logs) and
`AppError.publicMessage` (the wire). Defines the capability matrix that every
authorization decision resolves through.

**Testing:** pure unit tests.

---

## `packages/database/`

**Purpose:** The PostgreSQL schema, migrations, connection management,
tenant-scoped transactions, the audit writer, and development seed data.

**Why separate:** one place owns the schema, so a migration cannot be authored
from three different mental models — and swapping the ORM has one blast radius.

**Contains:** `schema/` (identity, tenancy, audit, crm, crm-lifecycle) ·
`client.ts` (`withTenantTransaction`) · `audit.ts` (the redacting writer) ·
`migrations/` (reviewed SQL, including the two `SECURITY DEFINER` lifecycle
functions) · `scripts/` (migrate, seed) · `testing/` (the restricted-role
integration harness).

**May depend on:** `@growth-os/contracts`, `drizzle-orm`, `postgres`.

**Must NOT:** import `@growth-os/auth` or `@growth-os/ui`. Make authorization
decisions — it _enforces_ isolation, it does not _decide_ access.

**Security boundary:** **the last line of tenant isolation.**
`withTenantTransaction` issues `SET LOCAL app.workspace_id`, which RLS policies
filter on. `audit.ts` centralises credential redaction so a caller cannot write
a secret into the audit trail even by accident.

**Testing:** integration tests against a real database, connected as a
**restricted non-owner role** — because superusers and table owners are exempt
from RLS and would make every isolation assertion pass vacuously.

---

## `packages/auth/`

**Purpose:** Password hashing, session lifecycle, tenancy authorization, and
the login use case.

**Why separate:** it is the highest-consequence code in the product and must be
reviewable in isolation — and framework-free, so the same code serves Next.js
today and Fastify later.

**Contains:** `password.ts` (Argon2id, the dummy-verify enumeration defence) ·
`session/` (opaque tokens, hashing, sliding expiry) · `authorization/`
(`resolveActor`, `requireWorkspaceAccess`) · `rate-limit.ts` · `http/`
(origin validation, safe redirects, cookie descriptors) · `login.ts` ·
`invitations.ts` · `password-reset.ts` (Stage 2.5 — enumeration-safe request,
single-use tokens, session revocation on completion).

**May depend on:** `@growth-os/contracts`, `@growth-os/database`,
`@node-rs/argon2`, `zod`.

**Must NOT:** import Next.js, React or `@growth-os/ui`. Contain HTTP framework
types — its `http/` helpers take primitives, not request objects.

**Security boundary:** **this package is the authentication and authorization
boundary.** `requireWorkspaceAccess` is the application layer of tenant
isolation; `login.ts` composes every control in a deliberate order.

**Testing:** exhaustive unit tests over the pure guards (mostly _negative_
cases), plus integration tests for the full login path.

---

## `packages/crm/` — Stage 2

**Purpose:** CRM application services — contacts, companies, acquisitions,
pipelines, opportunities, tasks and the activity timeline.

**Why separate:** the CRM is the destination every later capability writes
into. The worker (Stage 3) and the voice service boundary (Stage 13) must call
`createContact` without importing a Next.js application.

**Contains:** `shared/` (CrmContext, capability guards, `loadInTenant`,
pagination) · `identity/` (normalisation — the dedup matching keys) ·
`contacts/` (including `merge.ts` and `erasure.ts`) · `companies/` ·
`acquisitions/` (the provenance write path) · `pipelines/` · `opportunities/` ·
`tasks/` · `activities/` · `events/` · `ingestion/` (Stage 2.5 — **the single
boundary every automated channel calls**) · `import/` (CSV parser and the
chunked import) · `tags/` · `custom-fields/`.

**May depend on:** `@growth-os/contracts`, `@growth-os/database`,
`drizzle-orm`, `libphonenumber-js`, `zod`, `node:crypto`.

**Must NOT:** import `@growth-os/auth` (cycle), `@growth-os/ui`, React, Next.js
or anything in `apps/`. Decide _who the caller is_ — it receives an
already-authorized `TenantActor`.

**Security boundary:** **the IDOR defence is an API shape here.** There is no
`findById(id)`; the only loader is `loadInTenant`, which requires the
workspace. Every service checks a capability, then runs inside a tenant-scoped
transaction under RLS.

**Testing:** unit tests for pure logic; tenant isolation across all eight CRM
tables is tested in `@growth-os/database`'s integration suite as a restricted
non-owner role.

---

## `packages/forms/` — Stage 3

**Purpose:** Lead capture — web properties, form configuration and versioning,
and the public submission path.

**Why separate:** it owns the product's first ANONYMOUS PUBLIC WRITE PATH, and
that surface deserves to be reviewable on its own. It is also the template every
future channel follows: voice, ads webhooks and the public API will each be an
adapter in front of the same ingestion boundary.

**Contains:** `shared/` (forms context, origin normalisation) · `sites/` (web
properties, shared with the Stage 4 crawler) · `forms/` (admin CRUD, versioning,
publishing) · `public/` (form resolution, abuse controls, the submission
service, submission receipts) · `tracking/` (attribution sanitisation).

**May depend on:** `@growth-os/contracts`, `@growth-os/crm`,
`@growth-os/database`, `drizzle-orm`, `zod`, `node:crypto`.

**Must NOT:** import `@growth-os/auth` (cycle), `@growth-os/ui`, React, Next.js,
anything in `apps/`, or `node:fs`. **Insert a CRM row** — contacts, acquisitions
and opportunities belong to `ingestAcquisition`.

**Security boundary:** the browser never selects a tenant; a public key resolves
to exactly one workspace through one narrow `SECURITY DEFINER` function
(ADR-0026). Public ingestion runs under a system grant of exactly
`workspace:crm:contacts:write` (ADR-0025). A browser cannot state `sourceType`,
`confidence` or `searchQuery` — none is in the submission schema. No raw payload
is ever stored.

**Testing:** unit tests over the pure decisions (classification, origin
matching, value mapping, abuse signals) mostly as negatives; integration tests
against a real database as a **restricted non-owner role** covering tenant
isolation, idempotency under retry, and the full submission → CRM path.

---

## `apps/worker/` — Stage 3

**Purpose:** Background jobs — scheduled retention now, crawling from Stage 4.

**Why separate:** a long-running loop should not live inside a request handler.
It is a second **process**, not a second service: same repository, same packages,
same database, same deployment artefact, and **no network API between it and the
web app**.

**Contains:** `queue.ts` (claim, complete, fail, reclaim, schedule) ·
`jobs.ts` (the registered handlers) · `main.ts` (the loop and its lifecycle).

**May depend on:** `@growth-os/contracts`, `@growth-os/database`,
`@growth-os/auth`, `@growth-os/forms`, `drizzle-orm`.

**Must NOT:** import React, Next.js, `@growth-os/ui` or `apps/web`. Expose an
HTTP server. Carry PII in a job payload.

**Security boundary:** it connects as an operational role and does
platform-wide work, so the jobs it runs today are outside the tenant
transaction model. **Any future job touching customer data must open a
`withTenantTransaction`** for the workspace it acts on.

**⚠️ It owns the process-wide database pool** and is the only entry point that
closes it — see ADR-0030 and `architecture/worker-architecture.md`.

**Testing:** integration tests against a real database covering scheduling,
dedupe, concurrent claiming through `SKIP LOCKED`, retry and terminal failure,
stalled reclaim, and the four database-lifecycle properties.

---

## `packages/ui/`

**Purpose:** The design system — tokens, motion tokens and accessible React
primitives.

**Why separate:** so the visual language has one definition, and so a future
`apps/admin` or agency console inherits it rather than re-inventing it.

**Contains:** `tokens/tokens.css` (**the single source of truth for every
colour, space, radius, duration and easing**) · `primitives/` · `motion/` ·
`lib/cn.ts`.

**May depend on:** React, `clsx`, `tailwind-merge`. **Nothing internal.**

**Must NOT:** import any `@growth-os` package. Know about the database,
sessions or tenancy. Contain business logic.

**Security boundary:** none — but it owns accessibility, which is a safety
property. Focus rings, labelling and reduced-motion handling live here.

**Testing:** contrast ratios are computed from the real token values and
asserted in CI, so a documented contrast claim cannot silently regress.

---

## `docs/`

**Purpose:** The authoritative record of what Growth OS is and why it is built
this way. Product strategy, architecture, ADRs, design specifications, security
analysis, operations runbooks and the development log.

**Rule:** a document states what is true _now_. Planned work is labelled with
its roadmap stage. No document may claim functionality that does not exist.

---

## `scripts/`

**Purpose:** Repository safety verifiers. Both exist because a _silently
misconfigured_ check is worse than no check.

| Script                  | Asserts                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-boundaries.mjs` | Writes deliberately illegal imports and asserts lint **fails**. Caught `eslint-plugin-boundaries` passing everything                                     |
| `verify-gitignore.mjs`  | No first-party source is ignored, plausible _future_ source paths stay trackable, nothing dangerous is tracked. Caught unanchored `coverage/` and `out/` |

---

## `tests/`

**Purpose:** Cross-package integration tests (which belong to no single
package) and shared test setup.

`tests/integration/auth-login.test.ts` exercises the full sign-in path against
a real database. `tests/setup/web-setup.ts` provides the jsdom stubs component
tests need.

---

## `infrastructure/`

**Purpose:** Local development infrastructure — a `docker-compose.yml` for
PostgreSQL and the SQL that provisions a correctly restricted application role.

**Not** production deployment; that arrives with
[deployment-architecture.md](../architecture/deployment-architecture.md).

---

## Root files

| File                 | Purpose                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `package.json`       | npm workspaces, the command surface                                      |
| `tsconfig.base.json` | Strict TypeScript, extended by every workspace                           |
| `eslint.config.mjs`  | Lint rules **and** the module boundary enforcement                       |
| `vitest.config.ts`   | Three projects: unit, integration, web                                   |
| `.gitignore`         | Every rule justified in [gitignore-rationale.md](gitignore-rationale.md) |
| `.env.example`       | Documented placeholders. **The only tracked env file**                   |

---

## Directories that do not exist yet

Documented so their absence is understood as a decision, not an oversight
(Principle 13: do not create empty packages to match a diagram).

| Planned                                                   | Stage | Why not yet                                                                                                  |
| --------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `apps/worker`                                             | 3     | Nothing to schedule until the crawler exists                                                                 |
| `apps/api`                                                | 21    | Route handlers already serve the browser; a public API has no consumer                                       |
| `apps/voice`                                              | 13    | Separate Python system; boundary specified in [voice-architecture.md](../architecture/voice-architecture.md) |
| `packages/seo`, `/crm`, `/calendar`, `/automation`, `/ai` | 2–13  | Created with the features that need them                                                                     |
| `packages/observability`                                  | 3     | `console` with a documented shape suffices at one instance                                                   |
| `packages/events`                                         | 12    | No cross-module reactions exist yet                                                                          |
