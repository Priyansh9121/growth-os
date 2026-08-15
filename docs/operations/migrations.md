# Migrations

**Status:** Current (Stage 1) · **Governing ADR:** [0003](../decisions/ADR-0003-database-and-orm.md)

## Principles

1. **All schema change goes through a migration.** No manual `ALTER TABLE` in
   any environment, ever. A schema you cannot reproduce from the repository is
   a schema you cannot restore.
2. **Migrations are immutable once merged.** Fix forward with a new one.
   Editing a merged migration breaks the checksum for everyone who has applied
   it.
3. **Generated, then reviewed as SQL.** Every migration is _read_ before merge.
4. **Forward-only.** Down-migrations are not written: they are rarely correct
   under real data, and their existence encourages relying on them.

## Why review matters

A row-level security policy change must be visible as SQL in a pull request
diff. It is a security control, and an opaque schema delta would let it through
review unexamined. This is a large part of why Drizzle was chosen over an ORM
whose migrations are less legible.

## Workflow

```bash
# 1. Edit packages/database/src/schema/*.ts
npm run db:generate            # 2. generate SQL into migrations/
# 3. READ IT. Hand-edit where generation cannot express the intent —
#    RLS policies, partial indexes, constraint triggers, backfills.
npm run db:migrate             # 4. apply locally
npm run test:integration       # 5. prove isolation still holds
```

`drizzle-kit push` is **never** used outside a throwaway database: it mutates
schema without producing a reviewable artefact.

## Hand-written migrations

For anything Drizzle Kit cannot model:

```bash
npx drizzle-kit generate --custom --name=descriptive_name
```

`0001_tenant_row_level_security.sql` is the reference example — RLS policies,
the tenant-scope function, and comments explaining each decision.

## New tenant tables

The checklist in [../security/tenant-isolation.md](../security/tenant-isolation.md)
is mandatory: `workspace_id`, an index, `ENABLE` **and** `FORCE` RLS, `USING`
and `WITH CHECK` policies, grants, and a test proving another workspace sees
zero rows.

## Breaking changes: expand, then contract

Never rename or drop in one step.

1. **Expand** — add the new column, write to both.
2. **Backfill** — in batches, so a long transaction does not lock the table.
3. **Migrate reads** — deploy code reading the new column.
4. **Contract** — drop the old column, in a _later_ release.

Each step is independently deployable and independently revertible. A rollback
of application code must never meet a schema it cannot read.

## Production

Run as a **separate step before the application starts**, as the owner role, on
a dedicated connection. Never from application startup — concurrent instances
would race, and a failed migration would take the app down with it.

Backup first. Rehearse the restore. An untested backup is not a backup.
