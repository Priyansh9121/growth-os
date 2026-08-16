-- =============================================================================
-- Lead capture: sites, forms, versions, submissions, the job queue
-- =============================================================================
-- Stage 3. The DDL below is Drizzle-generated; everything after it is
-- hand-written, because Drizzle Kit models neither RLS policies nor functions
-- and this migration is substantially both.
--
-- THE HARD PART, STATED UP FRONT
-- An anonymous browser must be able to submit to a form. Every workspace-owned
-- table is RLS-protected on `app.workspace_id`, and an anonymous request has no
-- workspace scope — so a normal query for the form returns zero rows. **The
-- isolation layer that protects everything else is exactly what blocks the
-- lookup that would establish the scope.**
--
-- Resolved by ONE narrow SECURITY DEFINER function, `resolve_public_form`,
-- built to the same discipline as the Stage 2.5 lifecycle functions: one text
-- input, a fixed narrow output, pinned `search_path`, no dynamic SQL, and no
-- reach beyond the form and its published version. RLS is disabled nowhere.
--
-- Everything AFTER resolution runs inside an ordinary tenant transaction, so
-- the write path is exactly as scoped as an operator's (ADR-0026).
--
-- @see docs/decisions/ADR-0026-public-form-resolution.md
-- @see docs/decisions/ADR-0029-web-properties.md
-- @see docs/decisions/ADR-0030-worker-and-queue.md
-- @see docs/security/public-forms-threat-model.md
-- =============================================================================

CREATE TYPE "public"."site_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."site_verification_state" AS ENUM('unverified', 'pending', 'verified');--> statement-breakpoint
CREATE TYPE "public"."form_status" AS ENUM('draft', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."form_submission_outcome" AS ENUM('created', 'duplicate', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"status" "site_status" DEFAULT 'active' NOT NULL,
	"verification_state" "site_verification_state" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_token" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid,
	"outcome" "form_submission_outcome" NOT NULL,
	"contact_id" uuid,
	"acquisition_id" uuid,
	"opportunity_id" uuid,
	"matched_existing" boolean DEFAULT false NOT NULL,
	"source_type" text,
	"rejection_reason" text,
	"diagnostics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"status" "form_status" DEFAULT 'draft' NOT NULL,
	"published_version_id" uuid,
	"site_id" uuid,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_submission_limits" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_published_version_id_form_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."form_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sites_workspace_origin_unique" ON "sites" USING btree ("workspace_id","origin");--> statement-breakpoint
CREATE INDEX "sites_workspace_idx" ON "sites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "form_submissions_form_created_idx" ON "form_submissions" USING btree ("form_id","created_at");--> statement-breakpoint
CREATE INDEX "form_submissions_workspace_created_idx" ON "form_submissions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "form_submissions_contact_idx" ON "form_submissions" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_version_unique" ON "form_versions" USING btree ("form_id","version");--> statement-breakpoint
CREATE INDEX "form_versions_workspace_idx" ON "form_versions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_public_key_unique" ON "forms" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "forms_workspace_created_idx" ON "forms" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "forms_site_idx" ON "forms" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "public_submission_limits_window_idx" ON "public_submission_limits" USING btree ("window_started_at");--> statement-breakpoint
CREATE INDEX "jobs_claimable_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_unique" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_name_created_idx" ON "jobs" USING btree ("name","created_at");

-- -----------------------------------------------------------------------------
-- Constraints Drizzle does not model
-- -----------------------------------------------------------------------------

-- The public key's SHAPE is enforced by the database, not only by the code that
-- generates it. A short or non-hex key would still be unique, and would still
-- resolve — it would simply be guessable, and nothing else in the system would
-- notice. 32 hex characters is 128 bits.
ALTER TABLE "forms"
  ADD CONSTRAINT "forms_public_key_is_high_entropy"
  CHECK ("public_key" ~ '^[0-9a-f]{32}$');

-- A site's origin is scheme+host, never a path or a query. Enforced here as
-- well as in the normaliser, because an origin with a path silently breaks
-- every `Origin` header comparison that uses it.
ALTER TABLE "sites"
  ADD CONSTRAINT "sites_origin_is_an_origin"
  CHECK ("origin" ~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$');

-- A rejected submission has no CRM rows; an accepted one has at least a contact
-- and an acquisition. Stating it here stops a half-written receipt from being
-- representable at all.
ALTER TABLE "form_submissions"
  ADD CONSTRAINT "form_submissions_outcome_matches_result"
  CHECK (
    ("outcome" = 'rejected' AND "contact_id" IS NULL AND "acquisition_id" IS NULL)
    OR ("outcome" <> 'rejected' AND "contact_id" IS NOT NULL AND "acquisition_id" IS NOT NULL)
  );

-- Attempts may not exceed the ceiling that governs them.
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_attempts_within_max"
  CHECK ("attempts" <= "max_attempts");

-- =============================================================================
-- Row-level security
-- =============================================================================
-- ENABLE *and* FORCE on every workspace-owned table. ENABLE alone leaves the
-- table owner exempt, which silently makes the whole layer decorative.

ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sites" FORCE ROW LEVEL SECURITY;
CREATE POLICY sites_tenant_select ON "sites"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY sites_tenant_insert ON "sites"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY sites_tenant_update ON "sites"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
-- No DELETE policy: a site deactivates. Deleting one would orphan the forms
-- that referenced it and lose the origin a lead was attributed through.

ALTER TABLE "forms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forms" FORCE ROW LEVEL SECURITY;
CREATE POLICY forms_tenant_select ON "forms"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY forms_tenant_insert ON "forms"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY forms_tenant_update ON "forms"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
-- No DELETE policy: forms archive. Deleting one would cascade away every
-- submission receipt proving which leads it captured.

ALTER TABLE "form_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY form_versions_tenant_select ON "form_versions"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY form_versions_tenant_insert ON "form_versions"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());

-- ⚠️ NO UPDATE POLICY, AND NO DELETE POLICY. DELIBERATE.
--
-- A version is an immutable configuration snapshot, and the absence of the
-- policy is what enforces it — the same mechanism that makes `activities`
-- append-only (ADR-0014). If a version could be edited, a lead captured under
-- version 3 would silently start meaning whatever version 3 was later changed
-- to say, and "what did this form look like when that lead arrived?" would have
-- no answer. Editing a form writes a NEW version.

ALTER TABLE "form_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_submissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY form_submissions_tenant_select ON "form_submissions"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY form_submissions_tenant_insert ON "form_submissions"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- No UPDATE and no DELETE: a receipt records what happened. One that can be
-- rewritten cannot answer "did that enquiry arrive?".

-- -----------------------------------------------------------------------------
-- ⚠️ The two tables here that are NOT RLS-protected, and why
-- -----------------------------------------------------------------------------
-- Recorded in the migration because "a new table without a policy" is exactly
-- what a later audit should find an answer attached to. Neither carries a
-- `workspace_id`, so there is no tenant predicate a policy could apply.
--
--   public_submission_limits   Rate-limit counters keyed by a SHA-256 of the
--                              subject. Consulted before any tenant is known.
--                              Holds no tenant data and no PII — the IP is
--                              never stored, only its hash.
--
--   jobs                       Platform work: pruning expired sessions across
--                              every tenant, sweeping rate-limit windows. The
--                              worker connects as an operational role, not
--                              through a tenant transaction. Payloads carry
--                              identifiers and parameters, never PII.

COMMENT ON TABLE "public_submission_limits" IS
  'Public rate-limit counters, keyed by SHA-256 of the subject. No tenant column and no PII — deliberately not RLS-protected. See ADR-0030.';
COMMENT ON TABLE "jobs" IS
  'Platform background jobs. Not workspace-scoped and therefore not RLS-protected. Payloads must never carry PII. See ADR-0030.';
COMMENT ON TABLE "form_submissions" IS
  'Submission RECEIPTS. Deliberately does NOT store what the visitor typed — that becomes the contact, acquisition and opportunity, which erasure governs. See ADR-0021.';

-- =============================================================================
-- resolve_public_form
-- =============================================================================
-- THE ONE PRIVILEGED READ IN THE PUBLIC PATH.
--
-- Built to the Stage 2.5 discipline and deliberately boring:
--
--   * ONE text input. No workspace, no id, no caller-supplied predicate.
--   * A fixed, narrow output. It cannot be asked for different columns.
--   * `search_path` pinned, so a shadowing schema cannot redirect it.
--   * No dynamic SQL anywhere.
--   * Reads `forms` and `form_versions` only. It cannot reach a contact, a
--     submission, or another workspace's anything.
--   * Returns zero rows for an unknown key. The API layer answers identically
--     for unknown, draft, inactive and archived, so a caller cannot map which
--     keys were ever real.
--
-- The worst it can leak is the public configuration of one form whose key the
-- caller already holds — which is the configuration that form renders to the
-- open internet anyway.
--
-- ⚠️ SECURITY DEFINER runs as the function OWNER. If migrations are applied by
-- a superuser, RLS is inert inside it. That is why the function takes no
-- workspace and returns exactly one row: there is no predicate for a caller to
-- influence, so the absence of RLS inside changes nothing about what it can
-- return.
CREATE OR REPLACE FUNCTION resolve_public_form(p_public_key text)
RETURNS TABLE (
  form_id uuid,
  workspace_id uuid,
  form_name text,
  form_status form_status,
  version_id uuid,
  version_number integer,
  fields jsonb,
  settings jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT f.id,
         f.workspace_id,
         f.name,
         f.status,
         v.id,
         v.version,
         v.fields,
         v.settings
    FROM forms f
    -- INNER join: a form with no published version resolves to NOTHING, so a
    -- draft that has never been published is closed by construction rather
    -- than by a status check somebody remembered to write.
    JOIN form_versions v ON v.id = f.published_version_id
   WHERE f.public_key = p_public_key
     AND f.archived_at IS NULL
   LIMIT 1;
$$;

COMMENT ON FUNCTION resolve_public_form(text) IS
  'Resolves a public form key to its workspace and published configuration, for the anonymous submission path. The ONLY privileged read outside a tenant transaction. See ADR-0026.';

-- The application role calls it; it must never own it. EXECUTE is granted to
-- PUBLIC by default, so the revoke is what makes the grant meaningful.
REVOKE ALL ON FUNCTION resolve_public_form(text) FROM PUBLIC;

DO $$
DECLARE
  role_name text;
  granted boolean := false;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['growth_os_app', 'growth_os_app_test'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION resolve_public_form(text) TO %I', role_name);
      granted := true;
    END IF;
  END LOOP;

  IF NOT granted THEN
    RAISE WARNING 'No restricted application role found; grant EXECUTE on resolve_public_form after provisioning one (infrastructure/create-app-role.sql).';
  END IF;
END
$$;
