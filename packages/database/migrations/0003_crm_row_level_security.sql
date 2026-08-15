-- =============================================================================
-- CRM tenant isolation: row-level security for all eight CRM tables
-- =============================================================================
-- Hand-written, not generated. Drizzle Kit does not model RLS policies, and
-- this is exactly the kind of change that must be readable as SQL in a diff.
--
-- This applies the checklist from docs/security/tenant-isolation.md to every
-- table introduced by 0002. `audit_events` established the pattern in Stage 1
-- on a table whose contents were not critical; this is the pattern applied to
-- actual customer data.
--
-- POLICY SHAPE DIFFERS PER TABLE, DELIBERATELY (ADR-0013)
-- With RLS enabled, an operation with NO matching policy is DENIED. The
-- absence of a policy is therefore an enforcement mechanism, not an omission:
--
--   contacts, companies, pipelines,     SELECT + INSERT + UPDATE
--   pipeline_stages, opportunities,     (no DELETE — these soft-delete,
--   tasks, invitations                   close, cancel or archive instead)
--
--   acquisitions                        SELECT + INSERT + UPDATE
--                                       (UPDATE only for qualification —
--                                        enforced by a trigger below)
--
--   activities                          SELECT + INSERT only
--                                       (append-only: history that can be
--                                        edited is not history)
--
-- ⚠️ PostgreSQL exempts SUPERUSERS from RLS unconditionally, and TABLE OWNERS
-- unless FORCE is set. FORCE is applied to every table below; the superuser
-- hole is closed operationally by connecting as a restricted role, which the
-- integration harness asserts before running any isolation test.
--
-- @see docs/security/tenant-isolation.md
-- @see packages/database/src/client.ts (withTenantTransaction)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Standard tenant tables: read, create and modify within the current workspace.
-- -----------------------------------------------------------------------------
-- `app_current_workspace_id()` was created by 0001. It returns NULL when the
-- transaction is unscoped, so an unscoped query matches nothing — fail closed.

ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;
CREATE POLICY companies_tenant_select ON "companies"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY companies_tenant_insert ON "companies"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- USING controls which rows may be targeted; WITH CHECK controls the resulting
-- row. Both are required: without WITH CHECK, an UPDATE could move a row into
-- another tenant by rewriting workspace_id.
CREATE POLICY companies_tenant_update ON "companies"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY contacts_tenant_select ON "contacts"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY contacts_tenant_insert ON "contacts"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY contacts_tenant_update ON "contacts"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipelines" FORCE ROW LEVEL SECURITY;
CREATE POLICY pipelines_tenant_select ON "pipelines"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY pipelines_tenant_insert ON "pipelines"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY pipelines_tenant_update ON "pipelines"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "pipeline_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_stages_tenant_select ON "pipeline_stages"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY pipeline_stages_tenant_insert ON "pipeline_stages"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY pipeline_stages_tenant_update ON "pipeline_stages"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "opportunities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunities" FORCE ROW LEVEL SECURITY;
CREATE POLICY opportunities_tenant_select ON "opportunities"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY opportunities_tenant_insert ON "opportunities"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY opportunities_tenant_update ON "opportunities"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_tenant_select ON "tasks"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY tasks_tenant_insert ON "tasks"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY tasks_tenant_update ON "tasks"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant_select ON "invitations"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY invitations_tenant_insert ON "invitations"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY invitations_tenant_update ON "invitations"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- acquisitions — provenance, mutable ONLY for qualification
-- -----------------------------------------------------------------------------
ALTER TABLE "acquisitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acquisitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY acquisitions_tenant_select ON "acquisitions"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY acquisitions_tenant_insert ON "acquisitions"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY acquisitions_tenant_update ON "acquisitions"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- No DELETE policy: provenance is not deletable through normal operation.
-- Erasure (GDPR) is a separate, privileged, audited path — deliberately not
-- reachable from the application role (ADR-0013).

-- -----------------------------------------------------------------------------
-- Provenance immutability trigger
-- -----------------------------------------------------------------------------
-- The UPDATE policy above is necessary so an acquisition can be QUALIFIED. But
-- an UPDATE policy that permits qualification also permits rewriting the source
-- of a lead — which would silently falsify attribution, the one thing this
-- product must never do.
--
-- Rather than trusting every present and future service to only touch the
-- qualification columns, the database enforces it. A service-level rule is a
-- rule someone eventually forgets; a trigger is not.
CREATE OR REPLACE FUNCTION crm_acquisitions_provenance_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type       IS DISTINCT FROM OLD.source_type
  OR NEW.source_platform   IS DISTINCT FROM OLD.source_platform
  OR NEW.confidence        IS DISTINCT FROM OLD.confidence
  OR NEW.landing_path      IS DISTINCT FROM OLD.landing_path
  OR NEW.referrer_origin   IS DISTINCT FROM OLD.referrer_origin
  OR NEW.utm_source        IS DISTINCT FROM OLD.utm_source
  OR NEW.utm_medium        IS DISTINCT FROM OLD.utm_medium
  OR NEW.utm_campaign      IS DISTINCT FROM OLD.utm_campaign
  OR NEW.utm_term          IS DISTINCT FROM OLD.utm_term
  OR NEW.utm_content       IS DISTINCT FROM OLD.utm_content
  OR NEW.gclid             IS DISTINCT FROM OLD.gclid
  OR NEW.fbclid            IS DISTINCT FROM OLD.fbclid
  OR NEW.search_query      IS DISTINCT FROM OLD.search_query
  OR NEW.captured_at       IS DISTINCT FROM OLD.captured_at
  OR NEW.contact_id        IS DISTINCT FROM OLD.contact_id
  OR NEW.workspace_id      IS DISTINCT FROM OLD.workspace_id
  THEN
    RAISE EXCEPTION
      'Acquisition provenance is immutable. Only qualification fields may be updated (ADR-0012).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_acquisitions_provenance_immutable
  BEFORE UPDATE ON "acquisitions"
  FOR EACH ROW
  EXECUTE FUNCTION crm_acquisitions_provenance_is_immutable();

COMMENT ON TABLE "acquisitions" IS
  'Immutable provenance record of how a contact entered. Only qualification fields are updatable, enforced by trigger. See ADR-0012.';

-- -----------------------------------------------------------------------------
-- activities — append-only business timeline
-- -----------------------------------------------------------------------------
ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activities" FORCE ROW LEVEL SECURITY;
CREATE POLICY activities_tenant_select ON "activities"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY activities_tenant_insert ON "activities"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());

-- Deliberately NO update or delete policy. The timeline is a record of what
-- happened; history that can be rewritten is not history. This mirrors
-- audit_events, and the absence of the policy IS the control.

COMMENT ON TABLE "activities" IS
  'Append-only CRM business timeline, tenant-scoped. Distinct from audit_events: contains PII, readable by every operator. See ADR-0014.';

COMMENT ON TABLE "contacts" IS
  'Customer identity. Soft-deleted via deleted_at. Provenance lives on acquisitions, never here. See ADR-0011.';
