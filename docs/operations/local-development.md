# Local Development

**Status:** Current as of 2026-08-15

## Prerequisites

| Tool       | Version  | Note                                                                                                                  |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| Node.js    | ≥ 22.11  | `.nvmrc` pins 24. `@node-rs/argon2` ships prebuilt binaries                                                           |
| npm        | ≥ 10     | Ships with Node; no other package manager needed ([ADR-0002](../decisions/ADR-0002-monorepo-and-package-strategy.md)) |
| PostgreSQL | ≥ 16     | Row-level security is load-bearing, so this is a hard floor                                                           |
| Docker     | optional | Only for the bundled PostgreSQL                                                                                       |

## Setup

```bash
git clone <repo> && cd growth-os
npm install                       # installs all five workspaces
cp .env.example .env.local

# Generate a real session secret — never ship the placeholder:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Edit `.env.local`: set `SESSION_SECRET` to the generated value and point
`DATABASE_URL` at your database. Every variable is documented in
`.env.example`, and the app **refuses to boot** on an invalid one — the error
names the offending keys and never prints their values.

### Database — with Docker

```bash
docker compose -f infrastructure/docker-compose.yml up -d
```

Creates `growth_os`, `growth_os_test` and the restricted `growth_os_app` role.

### Database — without Docker

```bash
createdb growth_os
createdb growth_os_test
psql -d growth_os -f infrastructure/create-app-role.sql
```

> **⚠️ Read this before pointing at your own PostgreSQL.**
> Migrations must run as an owner. **The application must NOT connect as a
> superuser.** PostgreSQL exempts superusers from row-level security, so
> connecting as one silently disables the tenant-isolation backstop while
> everything continues to appear to work. See
> [../security/tenant-isolation.md](../security/tenant-isolation.md).

### Migrate, seed, run

```bash
npm run db:migrate
npm run db:seed
npm run dev            # http://localhost:3000
```

## Seeded accounts

Password comes from `SEED_PASSWORD` in `.env.local`. These are development
fixtures: every address uses the `.test` TLD, which RFC 6761 reserves as
permanently unresolvable, so they cannot receive mail even by accident.

| Account                     | Access                  | Demonstrates                                                                       |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `sam@abcplumbing.test`      | Owner, ABC Plumbing     | Direct membership                                                                  |
| `riley@northbeam.test`      | Agency admin, Northbeam | **Reaches 2 client workspaces with zero rows in `memberships`** — the agency model |
| `jordan@meridianlegal.test` | Owner, Meridian Legal   | The isolation counterexample: invisible to the other two                           |

Re-seeding is idempotent and destructive — it truncates and rebuilds.

## Daily commands

| Command                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `npm run dev`              | Development server                                   |
| `npm test`                 | All three test projects                              |
| `npm run test:unit`        | Fast, no database required                           |
| `npm run test:integration` | Needs `TEST_DATABASE_URL`; **skips itself** if unset |
| `npm run typecheck`        | Every workspace                                      |
| `npm run lint`             | Includes module boundary enforcement                 |
| `npm run verify:all`       | Every gate. **Run before committing**                |
| `npm run db:generate`      | Generate a migration after a schema change           |

## Testing without a database

`npm run test:unit` and `npm run test:web` need nothing but Node. The
integration project **skips rather than fails** when `TEST_DATABASE_URL` is
absent, so a missing database gives you a reduced suite, not a broken checkout.

## After changing the schema

```bash
# 1. Edit packages/database/src/schema/*.ts
npm run db:generate            # 2. generate the SQL migration
# 3. READ the generated SQL — always. Hand-edit where generation cannot express
#    the intent (RLS policies, partial indexes, constraint triggers).
npm run db:migrate             # 4. apply
```

New tenant tables must follow the checklist in
[../security/tenant-isolation.md](../security/tenant-isolation.md). It is not
optional, and there is no exception for "internal" tables.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md).
