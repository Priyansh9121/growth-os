# Growth OS

**An AI growth operating system.** Growth OS connects search visibility, lead
capture, CRM, AI agents and revenue attribution into one measurable loop — so a
business can see which acquisition work produced revenue, not just rankings.

> **Status: Stage 3 of 23 — lead capture & attribution ingestion.** The first
> complete commercial loop works: a business configures a form, embeds it on
> their website, and an **anonymous visitor becomes a CRM lead automatically**,
> with first-party acquisition classified by deterministic code rather than
> guessed. Background jobs run on `apps/worker`.
> **No SEO, voice, automation or revenue attribution exists yet**, and search
> queries come from Search Console — which is Stage 6, so nothing here reports
> one. Dashboard metrics are a labelled mix of live CRM counts and remaining
> fixtures. See [docs/product/product-roadmap.md](docs/product/product-roadmap.md).

---

## Why it exists

The tooling market sells one causal chain in disconnected halves:

```
search intent → ranking → click → session → enquiry → conversation
             → qualification → appointment → sale → revenue
```

SEO platforms stop at the ranking. CRMs start at the contact. Nobody owns the
join — so budget gets allocated by anecdote, and good work gets cancelled
alongside bad.

Growth OS's single defensible asset is **the join**: holding the whole chain so
that the question _"which keyword produced revenue?"_ has an answer, and so
that an AI can rank the next action by expected revenue rather than by SEO
severity.

Full argument: [docs/product/vision.md](docs/product/vision.md).

## Architecture in one diagram

A **modular monolith** — one deployable app, domain logic in packages with
lint-enforced boundaries, so extraction later is a deployment change rather
than a rewrite ([ADR-0001](docs/decisions/ADR-0001-architecture-style.md)).

```
apps/web (Next.js)   apps/worker (jobs)      ⬜ apps/api  ⬜ apps/voice
        │                                    │
        ▼                                    ▼
   @growth-os/auth ──▶ @growth-os/database ──▶ PostgreSQL (+ RLS)
        │              @growth-os/forms ──▶ @growth-os/crm
        ▼                     │
          @growth-os/contracts          @growth-os/ui
```

⬜ = designed, not built. Empty packages are not created to match a diagram.

## What actually works today

| Capability                                                         | State                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Email + password sign-in (Argon2id, opaque server-side sessions)   | ✅                                                                                                                  |
| Multi-tenancy: users → memberships → workspaces, plus agencies     | ✅                                                                                                                  |
| Agency transitive access to client workspaces                      | ✅                                                                                                                  |
| Three-layer tenant isolation, incl. PostgreSQL row-level security  | ✅                                                                                                                  |
| CSRF origin validation, login rate limiting, open-redirect defence | ✅                                                                                                                  |
| Append-only audit trail with centralised credential redaction      | ✅                                                                                                                  |
| Design system: OKLCH tokens, motion tiers, contrast enforced in CI | ✅                                                                                                                  |
| Flagship 3D login + continuous login → dashboard transition        | ✅                                                                                                                  |
| Reduced-motion / no-WebGL / mobile fallbacks                       | ✅                                                                                                                  |
| Dashboard shell, full navigation architecture, workspace switcher  | ✅                                                                                                                  |
| CRM: contacts, acquisitions, pipelines, opportunities, tasks       | ✅                                                                                                                  |
| Contact merge — previewed, forward-only, no unmerge                | ✅                                                                                                                  |
| PII erasure — irreversible, keeps deals and channel attribution    | ✅                                                                                                                  |
| Idempotent ingestion boundary; a retried webhook creates nothing   | ✅                                                                                                                  |
| CSV import — validate first, chunked writes, honest partial result | ✅                                                                                                                  |
| Tags, typed custom fields, companies                               | ✅                                                                                                                  |
| Lead capture: forms, versioning, publishing, embed, hosted form    | ✅                                                                                                                  |
| Public submission endpoint — anonymous, tenant-safe, idempotent    | ✅                                                                                                                  |
| First-party attribution: UTM, click ids, first touch, no cookies   | ✅                                                                                                                  |
| Deterministic source classification — **no LLM, no fabrication**   | ✅                                                                                                                  |
| Background worker: PostgreSQL queue, retries, retention jobs       | ✅                                                                                                                  |
| Spam & abuse controls — honeypot, timing, two-tier rate limiting   | 🔨 **no CAPTCHA provider; burst tier is per instance**                                                              |
| Password reset — enumeration-safe, single-use, revokes sessions    | 🔨 **no email provider; link is not delivered**                                                                     |
| Ask Growth AI — typed tool boundary, **no model connected**        | 🔨                                                                                                                  |
| Dashboard metrics                                                  | 🔨 **fixtures, labelled as such in the UI**                                                                         |
| Multi-factor authentication                                        | ⬜ Decided ([ADR-0024](docs/decisions/ADR-0024-multi-factor-authentication.md)), gated on the first external tenant |
| Erasure replay after a backup restore                              | ⬜ Specified; no backup system exists yet                                                                           |
| Website crawler, SEO audit, Search Console, rank tracking          | ⬜ Stages 4–6                                                                                                       |
| Voice, automation, revenue attribution                             | ⬜ Stages 7–15                                                                                                      |

## Repository structure

```
apps/web/              Next.js app: UI, route handlers, the public form
apps/worker/           Background jobs — a second process, not a second service
packages/contracts/    Types, Zod schemas, typed errors, the AI tool contract
packages/database/     Drizzle schema, migrations, tenant transactions, seed
packages/auth/         Passwords, sessions, tenancy authorization, invitations
packages/crm/          CRM services: contacts, provenance, pipelines, timeline
packages/forms/        Lead capture: sites, forms, the public submission path
packages/ui/           Design tokens and accessible React primitives
docs/                  Product, architecture, ADRs, design, security, ops
scripts/               Repository safety verifiers
tests/                 Cross-package integration tests and setup
infrastructure/        Local PostgreSQL via docker compose
```

Every directory's purpose, boundary and dependency rules:
[docs/engineering/repository-map.md](docs/engineering/repository-map.md).

## Quick start

**Requires** Node ≥ 22.11 and PostgreSQL ≥ 16.

```bash
git clone <repo> && cd growth-os
npm install
cp .env.example .env.local          # then edit DATABASE_URL and SESSION_SECRET

# Generate a real session secret:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Start PostgreSQL (or point DATABASE_URL at your own instance):
docker compose -f infrastructure/docker-compose.yml up -d

npm run db:migrate
npm run db:seed
npm run dev                          # http://localhost:3000
```

Seeded development accounts (password from `SEED_PASSWORD`):

| Account                     | Access                                                                 |
| --------------------------- | ---------------------------------------------------------------------- |
| `sam@abcplumbing.test`      | Owner of ABC Plumbing (direct)                                         |
| `riley@northbeam.test`      | Agency admin — reaches 2 client workspaces with **no** membership rows |
| `jordan@meridianlegal.test` | Owner of Meridian Legal (the isolation counterexample)                 |

Full setup, troubleshooting and the restricted-database-role requirement:
[docs/operations/local-development.md](docs/operations/local-development.md).

## Commands

| Command                                          | Purpose                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `npm run dev`                                    | Development server                                                |
| `npm run build`                                  | Production build                                                  |
| `npm test`                                       | All three test projects                                           |
| `npm run test:unit`                              | Pure logic — no database needed                                   |
| `npm run test:integration`                       | Real PostgreSQL; **skips itself** if `TEST_DATABASE_URL` is unset |
| `npm run typecheck`                              | TypeScript across every workspace                                 |
| `npm run lint`                                   | ESLint, including module boundaries                               |
| `npm run verify:boundaries`                      | Proves the boundary rules actually fail on violations             |
| `npm run verify:gitignore`                       | Proves `.gitignore` hides no first-party source                   |
| `npm run verify:all`                             | Everything above — run before committing                          |
| `npm run db:migrate` / `db:seed` / `db:generate` | Database lifecycle                                                |

## Security

Growth OS holds multi-tenant customer data, so a handful of properties are
treated as non-negotiable and are tested as **negatives** — we assert that
access is denied, because a passing happy path proves nothing about isolation.

- **Tenant isolation at three independent layers**: application guards, scoped
  transactions, and PostgreSQL row-level security — on **all seventeen** tenant
  tables, enabled _and_ forced. A forgotten `WHERE workspace_id` returns zero
  rows rather than another tenant's data.
  [docs/security/tenant-isolation.md](docs/security/tenant-isolation.md)
- **IDOR defence as an API shape**: `@growth-os/crm` exposes no `findById`. The
  only loader requires a workspace, so "fetch then check ownership" cannot be
  written. Foreign records return 404, never 403.
- **Nonce-based CSP** with `strict-dynamic`. `script-src` contains no
  `'unsafe-inline'` — asserted by an E2E test.
  [docs/decisions/ADR-0017-content-security-policy.md](docs/decisions/ADR-0017-content-security-policy.md)
- **Provenance cannot be fabricated**: a search keyword requires `declared`
  confidence, enforced in contracts, in the service, and by a PostgreSQL
  trigger that rejects any rewrite of a lead's source.
- **Authentication**: Argon2id (OWASP 2024 parameters), 256-bit opaque session
  tokens stored only as `SHA-256(HMAC(token, secret))`, httpOnly/SameSite=Lax
  cookies, session fixation defence, sliding + absolute expiry.
  [docs/security/authentication.md](docs/security/authentication.md)
- **Account enumeration**: unknown-email and wrong-password responses are
  identical in body _and_ timing — a dummy Argon2 verification runs when no
  user exists.
- **AI**: agents act only through typed tools that pass a capability check, an
  autonomy check and schema validation. An agent's permissions are always a
  subset of the user's.
  [docs/architecture/ai-agent-architecture.md](docs/architecture/ai-agent-architecture.md)
- **A person can be removed, and the business keeps its books.** Erasure
  anonymises in place across every table that holds their details — including
  timeline entries and tasks reachable only through a deal — while deal values,
  stages and channel attribution survive. Asserted by **searching** for the
  name afterwards, not by checking the columns the code happens to clear.
  [docs/security/data-lifecycle.md](docs/security/data-lifecycle.md)
- **The activity timeline stays append-only.** Merge and erasure are the only
  paths that can touch it, through a gated escalation whose limits are
  [written down honestly](docs/security/data-lifecycle.md#6-the-escalation-mechanism-and-its-honest-limits)
  rather than overstated.

Full threat model, including risks for features not yet built (crawler SSRF,
prompt injection, webhook forgery):
[docs/security/threat-model.md](docs/security/threat-model.md).

**Never commit** `.env*` files, credentials, keys, database dumps or customer
CSV exports. `npm run verify:gitignore` fails the build if any appear — and
asserts both directions, so a rule guarding customer data cannot quietly start
hiding a test fixture.

## Documentation

Documentation is written as decisions are made, not retrofitted. Start at
[docs/README.md](docs/README.md).

- **Product** — [vision](docs/product/vision.md) · [principles](docs/product/product-principles.md) · [roadmap](docs/product/product-roadmap.md) · [terminology](docs/product/terminology.md)
- **Architecture** — [overview](docs/architecture/overview.md) · [multi-tenancy](docs/architecture/multi-tenancy.md) · [**CRM**](docs/architecture/crm-architecture.md) · [AI agents](docs/architecture/ai-agent-architecture.md)
- **Decisions** — [18 ADRs](docs/decisions/) with rejected alternatives and costs
- **Design** — [design system](docs/design/design-system.md) · [motion](docs/design/motion-system.md) · [3D](docs/design/3d-system.md) · [login](docs/design/login-experience.md)
- **Development log** — [how we got here](docs/development-log/)

## Development rules

1. **Never fabricate a number.** Demo values are visibly labelled; a missing
   measurement renders as "not connected", never as zero.
2. **Deterministic systems own state.** AI proposes; the application decides,
   the service validates, the database confirms.
3. **No `users.workspace_id`.** Access is via memberships, always.
4. **Every tenant table gets `workspace_id`, an index and an RLS policy.**
   Checklist: [docs/security/tenant-isolation.md](docs/security/tenant-isolation.md).
5. **Never fabricate provenance.** `search_query` requires `declared`
   confidence. An invented keyword corrupts the number the product is sold on.
6. **A function that may run inside a transaction must accept one.** Opening a
   nested transaction takes a second pooled connection and can deadlock.
7. **Validate at every trust boundary** with Zod — including AI tool arguments.
8. **Document the decision, not just the code.** New architectural choices get
   an ADR; meaningful sessions get a development-log entry.
9. **Run `npm run verify:all` before committing.**

## Licence

UNLICENSED — private commercial project.
