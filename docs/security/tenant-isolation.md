# Tenant Isolation

**Status:** Implemented and tested (Stage 1; re-verified Stage 3)
**Last reviewed:** 2026-08-16
**Governing ADR:** [ADR-0005](../decisions/ADR-0005-multi-tenancy-model.md)

Cross-tenant data exposure is the one bug class that ends this company. It is
therefore defended at three independent layers, each of which assumes the
others may fail, and is tested as a **negative** — we assert access is
_denied_, because a passing happy path proves nothing about isolation.

---

## The three layers

```
Request
   │
   ├─ LAYER 1  Application    requireWorkspaceAccess(actor, workspaceId, capability)
   │                          → AuthorizationError (403) if absent
   │
   ├─ LAYER 2  Transaction    withTenantTransaction(db, workspaceId, fn)
   │                          → SET LOCAL app.workspace_id = <id>
   │
   └─ LAYER 3  Database       RLS policies filter on app.workspace_id
                              → zero rows, not another tenant's data
```

### What each layer catches

| Failure                                        | L1  | L2  | L3                |
| ---------------------------------------------- | --- | --- | ----------------- |
| New endpoint ships with no authorization check | ✗   | ✗   | ✅                |
| A query forgets `WHERE workspace_id`           | ✗   | —   | ✅                |
| IDOR via a guessed or enumerated ID            | ✅  | —   | ✅                |
| Stolen session used against another workspace  | ✅  | —   | ✅                |
| SQL injection reaching a tenant table          | ✗   | ✗   | ✅ (still scoped) |
| Connection pool leaks scope between requests   | —   | ✅  | —                 |
| **App role misconfigured as superuser**        | ✗   | ✗   | **✗ ⚠️**          |

The last row is the design's one true single point of failure, and it is
addressed below.

---

## Layer 1 — Application

```ts
const tenant = requireWorkspaceAccess(
  actor,
  workspaceId,
  'workspace:data:read',
);
```

Resolves access from the `Actor`'s membership graph, which was built **once**
per request by `resolveActor`. Nothing further down re-queries — one resolution
point means one place where identity can be wrong, and no time-of-check /
time-of-use gap between checks.

Two properties worth stating explicitly:

- **It returns a `TenantActor`, not a boolean.** Application services accept a
  `TenantActor`; the only way to obtain one is to pass this check. "Forgot to
  authorize" therefore becomes a compile error rather than a silent breach.
- **Missing and unauthorized produce the identical error.** Distinguishing them
  would confirm the existence of another tenant's workspace to anyone who can
  guess a UUID.

## Layer 2 — Scoped transactions

```ts
await withTenantTransaction(db, workspaceId, async (tx) => { … });
```

Issues `select set_config('app.workspace_id', $1, true)` inside the
transaction. Two details carry the weight:

**`SET LOCAL`, never `SET`.** `SET LOCAL` (the `true` third argument) is
reverted on commit or rollback. A plain `SET` persists for the life of the
_connection_ — and with a pool, that connection is handed to the next request,
which would silently inherit the previous tenant's scope. This is the most
dangerous mistake available in this design, and it is asserted by a test that
checks the setting is empty after a scoped transaction ends.

**`set_config`, never string interpolation.** `SET LOCAL` does not accept bind
parameters, so a naive implementation concatenates the workspace ID into SQL.
`set_config()` is a function call taking real parameters, so the value cannot
be interpreted as SQL.

`withUnscopedTransaction` exists for legitimately cross-tenant work
(authenticating a user, resolving memberships). It is named conspicuously so
its use is obvious in review and greppable in an audit.

### ⚠️ The one table that carries `workspace_id` and has NO row-level security

It is deliberate, and it is recorded here because "a table with `workspace_id`
and no policy" is exactly the kind of thing a later audit should find an answer
attached to.

| Table         | Why no RLS                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memberships` | It is the table that **defines** workspace access. `resolveActor` reads a user's memberships across all workspaces before any scope exists, so a policy keyed on `app.workspace_id` would match nothing and break authentication itself |

What protects `memberships` instead is that it is written only by invitation
acceptance and membership administration — both of which check a capability
first — and read only through `resolveActor`, which returns exactly one user's
own memberships. Verify with:

```sql
-- Every table carrying workspace_id that is not RLS-enabled AND forced.
-- Expect exactly: memberships.
SELECT c.relname FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
```

As of Stage 3 that query returns one row, still `memberships`. Every other
workspace-owned table — **twenty-one of them** — is ENABLE _and_ FORCE,
asserted per table by the integration suites. Stage 3 added four: `sites`,
`forms`, `form_versions` and `form_submissions`.

### The tables that carry no `workspace_id` at all

A different list, and worth keeping separate: these are not workspace-owned, so
RLS keyed on `app.workspace_id` would have nothing to filter by.

| Table                                | What it is                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `users`                              | A person, who may belong to several workspaces                                                          |
| `sessions`                           | A person's session, established before any workspace is chosen                                          |
| `password_reset_tokens`              | User-scoped, and read by someone who is not authenticated                                               |
| `agencies`                           | Sits **above** workspaces                                                                               |
| `agency_memberships`                 | Likewise                                                                                                |
| `workspaces`                         | The tenant itself                                                                                       |
| `jobs` (Stage 3)                     | **Platform** background work. Any future job touching customer data must open a `withTenantTransaction` |
| `public_submission_limits` (Stage 3) | Rate-limit counters keyed by `SHA-256(scope:value)`. Not tenant data — and **the IP is never stored**   |

`jobs` and `public_submission_limits` are the two to watch. The first is a
fan-out surface a later stage will be tempted to put a workspace's data in; the
second would become tenant data the moment anyone keyed it by workspace.

## Layer 3 — PostgreSQL row-level security

Defined in
[`migrations/0001_tenant_row_level_security.sql`](../../packages/database/migrations/0001_tenant_row_level_security.sql).

```sql
CREATE FUNCTION app_current_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid;
$$;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY audit_events_tenant_select ON audit_events FOR SELECT
  USING (workspace_id IS NOT NULL AND workspace_id = app_current_workspace_id());

CREATE POLICY audit_events_tenant_insert ON audit_events FOR INSERT
  WITH CHECK (workspace_id IS NOT NULL AND workspace_id = app_current_workspace_id());
```

Four decisions in that snippet:

1. **`missing_ok = true`** on `current_setting`, so an unscoped transaction
   yields `NULL` and matches nothing — **fail closed**, rather than raising an
   error a caller might handle into an allow.
2. **`STABLE`, not `IMMUTABLE`.** The value can change between statements in a
   transaction; `IMMUTABLE` would let the planner cache it across scopes, which
   would be a correctness bug in the isolation layer itself.
3. **`FORCE`** applies the policy to the table owner too. Without it, an
   application that happens to connect as the owner bypasses RLS entirely and
   the layer becomes decorative.
4. **`WITH CHECK` on INSERT.** Without it, reads would be isolated while writes
   were not — code inside workspace A's transaction could insert a row labelled
   workspace B. Subtle, easily missed, and specifically tested.

**No `UPDATE` or `DELETE` policy exists, and that is the control.** With RLS
enabled, an operation with no matching policy is denied. The audit trail is
append-only because the policies are absent.

---

## ⚠️ The operational precondition

**PostgreSQL exempts SUPERUSERS from row-level security, unconditionally.**
`FORCE` closes the table-owner hole; nothing closes the superuser hole.

> If the application connects to PostgreSQL as a superuser, **layer 3 does not
> exist** — and everything still appears to work perfectly.

The application role must be a **non-superuser, non-owner** role in every
shared environment.
[`infrastructure/create-app-role.sql`](../../infrastructure/create-app-role.sql)
provisions one correctly.

Because documentation alone cannot enforce this, the integration harness
creates a restricted role, connects as it, and calls `assertRestrictedRole`
**before** any isolation assertion — failing loudly if the test role turns out
to be a superuser. Otherwise every isolation test would pass vacuously, which
is the worst possible failure mode for a security test.

---

## The IDOR defence, as an API shape

Layer 1 stops an unauthorized _workspace_. A separate mistake is resolving a
record id without scoping it at all:

```ts
const contact = await findById(id); // loads ANY tenant's row
if (contact.workspaceId !== actor.workspaceId)
  // too late — already read
  throw new Error();
```

`@growth-os/crm` makes that **unexpressible**: there is no `findById`. The only
loader is `loadInTenant(tx, table, workspace, id)`, which puts the workspace in
the query. It raises `NotFoundError`, never `AuthorizationError`, so a 404 is
returned whether the record is absent or belongs to another tenant —
distinguishing them would confirm another tenant holds that id.

Verified live: a user requesting another workspace's contact id receives 404,
while its owner receives 200.

## Checklist for every new tenant table

Required before merge. There is no exception for "internal" tables.

- [ ] Column is named **`workspace_id`** (never `tenant_id` — one grep-able name).
- [ ] `uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`, unless
      platform-scoped rows are genuinely needed (as with `audit_events`).
- [ ] Indexed — usually a composite `(workspace_id, created_at)` matching the
      dominant query.
- [ ] `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`.
- [ ] `USING` policy for SELECT.
- [ ] `WITH CHECK` policy for INSERT (and UPDATE, if mutable).
- [ ] Deliberate decision on whether UPDATE/DELETE policies should exist at all.
- [ ] Grants issued to the application role in `create-app-role.sql`.
- [ ] An integration test asserting a **different** workspace sees zero rows.
- [ ] All access goes through `withTenantTransaction`.

`audit_events` is the reference implementation — copy it.

---

## What is tested

`packages/database/src/tenant-isolation.integration.test.ts`, all connected as
the restricted role:

| Assertion                                                              | Why it matters                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| An unfiltered `SELECT *` returns only the scoped tenant                | The exact mistake RLS exists to survive         |
| Another tenant's rows are absent, not an error                         | Isolation, not a permission message             |
| Platform-scoped rows (`workspace_id IS NULL`) are invisible to tenants | A tenant must not read platform security events |
| An unscoped transaction returns **nothing**                            | Fail closed                                     |
| A cross-tenant INSERT is **rejected**                                  | The `WITH CHECK` hole                           |
| UPDATE and DELETE affect zero rows                                     | Append-only enforcement                         |
| The setting is empty after the transaction ends                        | `SET LOCAL` does not leak across the pool       |
| RLS is both `ENABLED` and `FORCED`                                     | Guards against the owner exemption              |

Plus `packages/auth/src/authorization/guards.test.ts` at the application layer,
and a live end-to-end verification recorded in
[development-log/0003](../development-log/0003-authentication-and-tenancy.md).

## Known gaps

| Gap                                                     | Plan                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Only `audit_events` has RLS                             | It is the only tenant table that exists. The checklist above applies to every table added from Stage 2 |
| No automated check that all tenant tables have policies | Add a schema-introspection test once more than one exists                                              |
| Deployment could misconfigure the DB role               | Named in the deployment runbook; add a boot-time assertion that `current_user` is not a superuser      |
