# infrastructure/

Local development infrastructure only. Production deployment topology is
documented in
[docs/architecture/deployment-architecture.md](../docs/architecture/deployment-architecture.md)
and is not yet implemented.

## Contents

| File                  | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `docker-compose.yml`  | PostgreSQL 16 for local development                               |
| `create-app-role.sql` | Creates the test database and the **restricted** application role |

## Why the restricted role matters

PostgreSQL exempts superusers from row-level security. If the application
connects as a superuser, the tenant-isolation backstop is silently inert while
everything appears to work.

- **Migrations** run as the owner (`growth_os_owner`) — they need DDL.
- **The application** connects as `growth_os_app` — no superuser, no ownership,
  data access only.

An integration test connects as an equivalently restricted role and asserts
isolation, so a misconfiguration fails CI rather than reaching production.

## Usage

```bash
docker compose -f infrastructure/docker-compose.yml up -d
docker compose -f infrastructure/docker-compose.yml logs -f postgres
docker compose -f infrastructure/docker-compose.yml down       # keeps data
docker compose -f infrastructure/docker-compose.yml down -v    # deletes data
```

`create-app-role.sql` runs only on **first** initialisation of the volume. If
you change it, recreate the volume with `down -v`.

## No Docker?

Point `DATABASE_URL` at any PostgreSQL ≥ 16 and run `create-app-role.sql`
against it manually. See
[docs/operations/local-development.md](../docs/operations/local-development.md).
