# Database Operations

**Status:** Current (Stage 1)

## Roles — the security-critical part

| Role              | Used by             | Privileges                                                         |
| ----------------- | ------------------- | ------------------------------------------------------------------ |
| `growth_os_owner` | **Migrations only** | Owns the schema; DDL                                               |
| `growth_os_app`   | **The application** | SELECT/INSERT/UPDATE/DELETE. **Not** a superuser, **not** an owner |

> **PostgreSQL exempts superusers from row-level security, unconditionally.**
> `FORCE ROW LEVEL SECURITY` closes the table-owner hole; nothing closes the
> superuser hole. If the application connects as a superuser, tenant isolation
> layer 3 does not exist — and everything still appears to work.

`infrastructure/create-app-role.sql` provisions the restricted role, including
`ALTER DEFAULT PRIVILEGES` so tables created by **future** migrations inherit
the grants automatically. Without that, every new table would be silently
unreadable by the application.

## Connection pooling

Pool size via `DATABASE_POOL_MAX` (default 10). `connect_timeout` is 10s so an
unreachable database fails fast rather than hanging a request.

**A pooler must preserve `SET LOCAL` semantics.** A transaction-mode pooler
that recycles a connection mid-transaction would break tenant scoping — which
is silent and catastrophic. Any pooler must be verified against the isolation
suite, not assumed compatible.

## Routine tasks

```bash
npm run db:migrate                  # apply pending migrations
npm run db:generate                 # generate one after a schema change
npm run db:seed                     # development fixtures (refuses in production)
npm run db:studio                   # browse
```

## Health checks

```sql
-- RLS must be ENABLED and FORCED on every tenant table
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';

-- The application role must NOT be a superuser
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'growth_os_app';

-- Session table growth
SELECT count(*) FILTER (WHERE expires_at < now()) AS expired, count(*) AS total FROM sessions;
```

## Maintenance

Expired sessions are pruned opportunistically on validation; a scheduled sweep
(`pruneExpiredSessions`) lands with `apps/worker` at Stage 3. Audit event
retention is policy-driven and not yet implemented.

Autovacuum defaults are fine at current volume. `events` and `rankings`
(Stage 15) will need tuning and partitioning.
