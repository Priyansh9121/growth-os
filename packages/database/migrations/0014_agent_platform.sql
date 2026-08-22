-- =============================================================================
-- The agent platform: five tables, and the constraints that make them trustworthy
-- =============================================================================
-- Hand-written, not Drizzle-generated — the convention since 0009. Drizzle Kit
-- models neither CHECK constraints, RLS policies nor triggers, and all three
-- carry the load here.
--
-- ⚠️ THE POINT OF THIS MIGRATION IS `agent_outputs.agent_run_id NOT NULL`.
-- Everything else is scaffolding around one rule: a claim about what an AI
-- proposed must name the run that produced it, or it is not a record of
-- anything. Enforced here, in the database, because an application-level check
-- is only as good as the number of code paths that remember to call it. The
-- test for it asserts the row is REFUSED (AGENTS.md §6).
--
-- ⚠️ NO `channel_credentials` TABLE, DELIBERATELY.
-- The original brief had six tables. This repository has no reversible
-- encryption anywhere — every secret is one-way HMAC or hash — so a credential
-- store would have meant inventing a secrets pattern as a side effect of a
-- schema task, with no connector to validate it and no threat model written.
-- Deferred to the connector phase (ADR-0063 alternative B). No column below
-- may be used as a substitute: `agent_runs.inputs` is structured run input.
--
-- ⚠️ AUTONOMY IS `AutonomyLevel` (1–4) FROM contracts/src/ai/tool.ts.
-- Not a new vocabulary. The CHECK below bounds the same four levels the tool
-- guard chain enforces at step 4, and `enums.test.ts` asserts those four values
-- against this bound so the two cannot drift.
--
-- ⚠️ ATTRIBUTION IS A JOIN, NOT A PROVENANCE RECORD.
-- `acquisitions` owns channel provenance under ADR-0012. Nothing below copies a
-- UTM, a source or a confidence.
--
-- Enum types are CREATEd, never ALTER TYPE ... ADD VALUE, so they are usable in
-- the same transaction — 0013 documents why that distinction is load-bearing:
-- drizzle applies every pending migration inside ONE transaction.
--
-- @see docs/decisions/ADR-0063-agent-platform-data-model.md
-- @see docs/decisions/ADR-0012-provenance-model.md
-- =============================================================================

CREATE TYPE "agent_run_status"    AS ENUM ('running', 'completed', 'failed');
CREATE TYPE "approval_decision"   AS ENUM ('approved', 'rejected', 'edited');
CREATE TYPE "attribution_outcome" AS ENUM (
  'contact_created',
  'acquisition_recorded',
  'opportunity_created',
  'opportunity_stage_changed',
  'opportunity_won'
);

-- -----------------------------------------------------------------------------
-- campaigns — the coordination unit
-- -----------------------------------------------------------------------------
CREATE TABLE "campaigns" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"        uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name"                text NOT NULL,
  "description"         text,
  "starts_at"           timestamptz NOT NULL,
  "ends_at"             timestamptz,
  "created_by_user_id"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "campaigns_name_is_bounded"
    CHECK ("name" <> '' AND length("name") <= 200),

  -- NULL `ends_at` means open-ended, which is a real campaign shape. This
  -- constrains only the ordering when an end IS declared.
  CONSTRAINT "campaigns_ends_after_it_starts"
    CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);

CREATE INDEX "campaigns_workspace_starts_idx" ON "campaigns" ("workspace_id", "starts_at");

COMMENT ON TABLE "campaigns" IS
  'Named coordination unit for agent runs. Nullable FK target: a run need not belong to one. See ADR-0063.';

-- -----------------------------------------------------------------------------
-- agent_runs — one invocation. This table is ToolContext.runId's referent.
-- -----------------------------------------------------------------------------
CREATE TABLE "agent_runs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"    uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "campaign_id"     uuid REFERENCES "campaigns"("id") ON DELETE SET NULL,
  "agent_key"       text NOT NULL,
  "status"          "agent_run_status" NOT NULL DEFAULT 'running',
  "inputs"          jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at"      timestamptz NOT NULL DEFAULT now(),
  "completed_at"    timestamptz,
  "failure_reason"  text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "agent_runs_agent_key_is_bounded"
    CHECK ("agent_key" <> '' AND length("agent_key") <= 100),

  -- Both directions. A finished run without a completion time is unmeasurable;
  -- a running run WITH one is a lie about a run still in flight.
  CONSTRAINT "agent_runs_completion_matches_status"
    CHECK (
      ("status" = 'running'  AND "completed_at" IS NULL)
      OR ("status" IN ('completed', 'failed') AND "completed_at" IS NOT NULL)
    ),

  -- A reason attached to a run that did not fail would be read as a failure.
  CONSTRAINT "agent_runs_failure_reason_requires_failure"
    CHECK ("failure_reason" IS NULL OR "status" = 'failed')
);

CREATE INDEX "agent_runs_workspace_started_idx" ON "agent_runs" ("workspace_id", "started_at");
CREATE INDEX "agent_runs_campaign_idx"          ON "agent_runs" ("campaign_id", "started_at");
CREATE INDEX "agent_runs_workspace_status_idx"  ON "agent_runs" ("workspace_id", "status");

COMMENT ON TABLE "agent_runs" IS
  'One agent invocation. agent_runs.id IS ToolContext.runId from contracts/src/ai/tool.ts. See ADR-0063.';

-- -----------------------------------------------------------------------------
-- agent_outputs — one proposed action, and the rule this migration exists for
-- -----------------------------------------------------------------------------
CREATE TABLE "agent_outputs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"    uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,

  -- ⚠️ NOT NULL. The provenance rule. An output that cannot name its run is an
  -- unattributed claim about what an AI decided.
  "agent_run_id"    uuid NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,

  "kind"            text NOT NULL,
  "content"         jsonb NOT NULL,
  "autonomy_level"  smallint NOT NULL DEFAULT 2,
  "published_at"    timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "agent_outputs_kind_is_bounded"
    CHECK ("kind" <> '' AND length("kind") <= 100),

  -- The four levels of contracts' AutonomyLevel: 1 RECOMMEND, 2
  -- DRAFT_WITH_APPROVAL, 3 PRE_APPROVED, 4 AUTONOMOUS. Phase 0 writes only 2.
  CONSTRAINT "agent_outputs_autonomy_level_is_known"
    CHECK ("autonomy_level" BETWEEN 1 AND 4)
);

CREATE INDEX "agent_outputs_run_idx" ON "agent_outputs" ("agent_run_id");
CREATE INDEX "agent_outputs_workspace_created_idx"
  ON "agent_outputs" ("workspace_id", "created_at");

COMMENT ON TABLE "agent_outputs" IS
  'A draft or proposed action. agent_run_id is NOT NULL by design: provenance is the point. autonomy_level is contracts AutonomyLevel 1-4. See ADR-0063.';

-- -----------------------------------------------------------------------------
-- approvals — append-only human decisions
-- -----------------------------------------------------------------------------
CREATE TABLE "approvals" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"       uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_output_id"    uuid NOT NULL REFERENCES "agent_outputs"("id") ON DELETE CASCADE,
  "decision"           "approval_decision" NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at"         timestamptz NOT NULL DEFAULT now(),
  "edit_diff"          jsonb,
  "note"               text,

  -- ⚠️ BOTH DIRECTIONS, as one equality.
  -- `edited` exists as a decision distinct from `approved` because "approved as
  -- written" and "had to be rewritten first" are different facts about the
  -- agent. An `edited` row with no diff, or a diff on a plain `approved`,
  -- would each destroy that distinction while looking intact.
  CONSTRAINT "approvals_edit_diff_iff_edited"
    CHECK (("decision" = 'edited') = ("edit_diff" IS NOT NULL))
);

CREATE INDEX "approvals_output_decided_idx"    ON "approvals" ("agent_output_id", "decided_at");
CREATE INDEX "approvals_workspace_decided_idx" ON "approvals" ("workspace_id", "decided_at");

COMMENT ON TABLE "approvals" IS
  'Append-only record of human decisions about drafts. Not unique per output: re-deciding appends. See ADR-0063.';

-- -----------------------------------------------------------------------------
-- attribution_events — the thin join onto ADR-0012's provenance
-- -----------------------------------------------------------------------------
CREATE TABLE "attribution_events" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"     uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_output_id"  uuid NOT NULL REFERENCES "agent_outputs"("id") ON DELETE CASCADE,
  "outcome"          "attribution_outcome" NOT NULL,
  "contact_id"       uuid REFERENCES "contacts"("id") ON DELETE CASCADE,
  "acquisition_id"   uuid REFERENCES "acquisitions"("id") ON DELETE CASCADE,
  "opportunity_id"   uuid REFERENCES "opportunities"("id") ON DELETE CASCADE,
  "occurred_at"      timestamptz NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),

  -- Exactly one target, and WHICH one is decided by the outcome.
  --
  -- ⚠️ `ELSE false` IS LOAD-BEARING. A CHECK that evaluates to NULL PASSES in
  -- PostgreSQL, so a CASE with no ELSE would let a newly added enum value
  -- through with every target column NULL — silently defeating the constraint
  -- at exactly the moment someone extends the enum. `false` makes that a loud
  -- failure in the migration that adds the value, which is where the decision
  -- about its target belongs.
  CONSTRAINT "attribution_events_target_matches_outcome"
    CHECK (
      CASE "outcome"
        WHEN 'contact_created' THEN
          "contact_id" IS NOT NULL AND "acquisition_id" IS NULL AND "opportunity_id" IS NULL
        WHEN 'acquisition_recorded' THEN
          "acquisition_id" IS NOT NULL AND "contact_id" IS NULL AND "opportunity_id" IS NULL
        WHEN 'opportunity_created' THEN
          "opportunity_id" IS NOT NULL AND "contact_id" IS NULL AND "acquisition_id" IS NULL
        WHEN 'opportunity_stage_changed' THEN
          "opportunity_id" IS NOT NULL AND "contact_id" IS NULL AND "acquisition_id" IS NULL
        WHEN 'opportunity_won' THEN
          "opportunity_id" IS NOT NULL AND "contact_id" IS NULL AND "acquisition_id" IS NULL
        ELSE false
      END
    )
);

CREATE INDEX "attribution_events_output_idx" ON "attribution_events" ("agent_output_id");
CREATE INDEX "attribution_events_workspace_outcome_idx"
  ON "attribution_events" ("workspace_id", "outcome", "occurred_at");

COMMENT ON TABLE "attribution_events" IS
  'Join between a published agent_output and a CRM outcome. Records precedence, never causation, and no channel data (ADR-0012 owns that). See ADR-0063.';

-- -----------------------------------------------------------------------------
-- An unpublished draft cannot have caused anything
-- -----------------------------------------------------------------------------
-- A CHECK cannot see another table, so this is a trigger. Deliberately NOT
-- SECURITY DEFINER: it runs with the caller's privileges, so an output in
-- another workspace is invisible to the lookup and the insert fails closed —
-- which is the correct answer to a cross-tenant attribution attempt anyway.
CREATE OR REPLACE FUNCTION agent_attribution_requires_published_output()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  published_when timestamptz;
  output_exists  boolean;
BEGIN
  SELECT true, "published_at" INTO output_exists, published_when
  FROM "agent_outputs" WHERE "id" = NEW."agent_output_id";

  IF output_exists IS NULL THEN
    RAISE EXCEPTION
      'attribution_events references agent_output % which is not visible', NEW."agent_output_id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF published_when IS NULL THEN
    RAISE EXCEPTION
      'attribution_events references agent_output % which was never published', NEW."agent_output_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "attribution_events_output_must_be_published"
  BEFORE INSERT OR UPDATE ON "attribution_events"
  FOR EACH ROW
  EXECUTE FUNCTION agent_attribution_requires_published_output();

-- =============================================================================
-- Row-level security — AGENTS.md §5: every workspace-owned table, ENABLE + FORCE
-- =============================================================================
-- Policy shape differs per table, and the ABSENCE of a policy is the
-- enforcement (ADR-0013): with RLS enabled, an operation with no matching
-- policy is DENIED.
--
--   campaigns, agent_runs, agent_outputs   SELECT + INSERT + UPDATE
--                                          (runs change status; outputs get
--                                           published; no DELETE on any)
--
--   approvals, attribution_events          SELECT + INSERT only
--                                          (append-only: a decision that can be
--                                           rewritten is not an audit record,
--                                           and an observed sequence is not
--                                           editable after the fact)
--
-- `app_current_workspace_id()` was created by 0001 and returns NULL when the
-- transaction is unscoped, so an unscoped query matches nothing — fail closed.

ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY campaigns_tenant_select ON "campaigns"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY campaigns_tenant_insert ON "campaigns"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY campaigns_tenant_update ON "campaigns"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_runs_tenant_select ON "agent_runs"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY agent_runs_tenant_insert ON "agent_runs"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- WITH CHECK as well as USING: without it an UPDATE could move a run into
-- another tenant by rewriting workspace_id.
CREATE POLICY agent_runs_tenant_update ON "agent_runs"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "agent_outputs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_outputs" FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_outputs_tenant_select ON "agent_outputs"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY agent_outputs_tenant_insert ON "agent_outputs"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY agent_outputs_tenant_update ON "agent_outputs"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_tenant_select ON "approvals"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY approvals_tenant_insert ON "approvals"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "attribution_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attribution_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY attribution_events_tenant_select ON "attribution_events"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY attribution_events_tenant_insert ON "attribution_events"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
