-- =============================================================================
-- Tenant isolation backstop: PostgreSQL row-level security
-- =============================================================================
-- Hand-written, not generated. Drizzle Kit does not model RLS policies, and
-- this is exactly the kind of change that must be visible as SQL in a diff.
--
-- WHAT THIS DOES
-- Constrains every statement against a tenant-scoped table to the workspace
-- named by the transaction-local setting `app.workspace_id`, which
-- `withTenantTransaction()` sets via `set_config(..., true)`.
--
-- WHY
-- Application-level `WHERE workspace_id = ?` filtering is necessary but not
-- sufficient. One forgotten clause, once, in any query for the life of the
-- product, is a cross-tenant data breach. With these policies in place, a
-- forgotten clause returns zero rows instead of another tenant's data.
--
-- ⚠️  OPERATIONAL PRECONDITION — READ THIS
-- PostgreSQL exempts SUPERUSERS and TABLE OWNERS from row-level security
-- unless FORCE is enabled. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` below
-- closes the table-owner hole, but a SUPERUSER is still exempt and no
-- statement can change that. The application must therefore never connect as
-- a superuser in any shared environment.
--
-- `scripts/create-app-role.sql` provisions a correctly restricted role, and
-- an integration test connects as that role and asserts isolation — because a
-- security control that is only documented is a security control that is
-- eventually misconfigured.
--
-- @see docs/security/tenant-isolation.md
-- @see packages/database/src/client.ts (withTenantTransaction)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: read the current tenant scope.
-- -----------------------------------------------------------------------------
-- The second argument to current_setting() is `missing_ok`, so an unset
-- setting yields NULL rather than raising. That matters because an unscoped
-- transaction must FAIL CLOSED (match no rows), not error in a way a caller
-- might catch and treat as empty.
--
-- STABLE, not IMMUTABLE: the value can change between statements within a
-- transaction. Declaring it IMMUTABLE would permit the planner to cache it
-- across scopes, which would be a correctness bug in the isolation layer.
CREATE OR REPLACE FUNCTION app_current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_workspace_id() IS
  'Returns the workspace scope of the current transaction, or NULL when unscoped. Used by every tenant RLS policy.';

-- -----------------------------------------------------------------------------
-- audit_events
-- -----------------------------------------------------------------------------
-- The first tenant-scoped table in Growth OS. It deliberately establishes the
-- pattern that every future tenant table copies.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;

-- FORCE makes the policy apply to the table owner as well. Without it, an
-- application that happens to connect as the owner silently bypasses RLS and
-- the whole layer becomes decorative.
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

-- Read policy.
--
-- Note `workspace_id IS NOT NULL`: rows with a NULL workspace are
-- platform-scoped events (a failed sign-in, where no authenticated identity
-- exists yet). Tenants must not read platform security events, so those rows
-- are invisible to every tenant-scoped transaction by construction.
CREATE POLICY audit_events_tenant_select ON "audit_events"
  FOR SELECT
  USING (
    workspace_id IS NOT NULL
    AND workspace_id = app_current_workspace_id()
  );

-- Write policy.
--
-- WITH CHECK constrains rows being written. Without it, code inside a
-- transaction scoped to workspace A could still INSERT a row labelled
-- workspace B — reads would be isolated while writes were not, which is a
-- subtle and easily missed hole.
CREATE POLICY audit_events_tenant_insert ON "audit_events"
  FOR INSERT
  WITH CHECK (
    workspace_id IS NOT NULL
    AND workspace_id = app_current_workspace_id()
  );

-- No UPDATE or DELETE policy is created, and that is deliberate: with RLS
-- enabled, an operation with no matching policy is denied. The audit trail is
-- append-only, and the absence of a policy is what enforces it. Platform
-- retention jobs run outside the tenant path with an explicitly elevated role.

COMMENT ON TABLE "audit_events" IS
  'Append-only tenant audit trail. RLS-scoped to app.workspace_id. Rows with NULL workspace_id are platform-scoped and invisible to tenants.';
