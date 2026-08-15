-- =============================================================================
-- CRM data lifecycle: merge, erasure, ingestion receipts, tags, custom fields
-- =============================================================================
-- Hand-written, not generated. Drizzle Kit models neither RLS policies nor
-- functions, and this migration is almost entirely both.
--
-- WHAT THIS MIGRATION IS FOR
-- Stage 2 built a CRM that can record customer data. This makes it safe to
-- hold customer data: duplicates become resolvable, identity becomes erasable,
-- and automated ingestion becomes retry-safe — all before Stage 3 starts
-- writing real people into it automatically.
--
-- THE HARD PART, STATED UP FRONT
-- `activities` deliberately has NO UPDATE policy. With RLS enabled, the
-- absence of a policy is what makes the timeline append-only (ADR-0014), and
-- that is a property worth keeping. But merge must re-point `contact_id`, and
-- erasure must clear a summary that contains a person's name.
--
-- The escalation path is narrow and conspicuous:
--
--   1. a transaction-local flag, `app.lifecycle_operation`
--   2. an UPDATE policy on `activities` that requires it
--   3. a BEFORE UPDATE trigger that restricts WHICH columns may change,
--      differently for merge and for erasure
--   4. two SECURITY DEFINER functions that are the only sanctioned setters,
--      which pin `search_path`, re-verify the workspace, and clear the flag
--      again on the way out
--
-- ⚠️  WHAT THIS DOES AND DOES NOT GUARANTEE — read ADR-0019 §4. It makes
-- accidental history mutation impossible and deliberate mutation conspicuous
-- and greppable. It is not a defence against a developer who sets the flag on
-- purpose, and nothing at the application layer would be.
--
-- ⚠️  SECURITY DEFINER AND SUPERUSERS
-- A SECURITY DEFINER function runs as its OWNER. If migrations are applied by
-- a superuser, RLS is inert inside these functions, because PostgreSQL exempts
-- superusers unconditionally. That is exactly why every statement inside them
-- carries its own explicit `workspace_id = p_workspace` predicate rather than
-- leaning on the policy — the functions are correct with or without RLS. The
-- operational requirement (own the schema with a non-superuser role) is
-- recorded in docs/security/data-lifecycle.md.
--
-- @see docs/decisions/ADR-0019-contact-merge.md
-- @see docs/decisions/ADR-0020-privacy-erasure.md
-- @see docs/decisions/ADR-0021-ingestion-and-idempotency.md
-- @see docs/decisions/ADR-0022-custom-field-storage.md
-- @see docs/security/data-lifecycle.md
-- =============================================================================

CREATE TYPE "public"."crm_custom_field_type" AS ENUM('text', 'number', 'boolean', 'date', 'single_select');--> statement-breakpoint
CREATE TYPE "public"."crm_tag_tone" AS ENUM('neutral', 'signal', 'attention', 'critical');--> statement-breakpoint
CREATE TYPE "public"."crm_import_batch_status" AS ENUM('validating', 'ready', 'importing', 'completed', 'partial', 'failed');--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- custom fields (contact-scoped)
-- ---------------------------------------------------------------------------
-- WHY A DEFINITIONS TABLE AND NOT A JSONB COLUMN ON contacts
-- Because erasure has to be able to ENUMERATE every place PII lives. A
-- free-form `custom_data` blob is precisely the shadow PII store an erasure
-- routine misses, and it validates nothing (ADR-0022).
--
-- Contact-scoped with a real foreign key, rather than a polymorphic
-- entity_type/entity_id pair: a polymorphic column cannot carry an FK, and
-- these rows hold customer data that must cascade correctly.
CREATE TABLE "contact_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "crm_custom_field_type" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"value_text" text,
	"value_number" double precision,
	"value_boolean" boolean,
	"value_date" date,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- contact_tags
-- ---------------------------------------------------------------------------
-- Carries workspace_id even though it is derivable from either side: an RLS
-- policy filters on a column of the row being touched, and expressing a join
-- there would mean a subquery on every read.
CREATE TABLE "contact_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"tagged_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- tags — a controlled vocabulary, not free text on the contact
-- ---------------------------------------------------------------------------
-- `slug` is trimmed, lowercased and whitespace-collapsed, and is the
-- uniqueness key, so "Hot Lead" and "hot lead" cannot both exist and
-- silently split one segment in two.
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"tone" "crm_tag_tone" DEFAULT 'neutral' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- erasure_requests — a permanent record that an erasure happened
-- ---------------------------------------------------------------------------
-- Erasure clears the LIVE database; it does not reach into backups. Restoring
-- one resurrects data someone asked to have removed, unless the erasures are
-- replayed before the restored data returns to service. That replay needs a
-- list, and this is it.
--
-- `contact_id` deliberately has NO foreign key: the log must stay replayable
-- against a restored database whose contact rows are a different generation.
-- `affected_counts` holds counts only — a log that preserved what was erased
-- would defeat the erasure (ADR-0020).
CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"affected_counts" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- import_batches — one CSV upload and how it resolved
-- ---------------------------------------------------------------------------
-- Counts and the column mapping only, never parsed rows. The uploaded file is
-- parsed in memory and never written to disk, so there is no upload directory
-- to leak, scan, or forget to clean up (ADR-0023).
--
-- `filename` is stored so a batch is identifiable, and must NEVER be logged:
-- a filename can carry a customer's name.
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"status" "crm_import_batch_status" DEFAULT 'validating' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"matched_existing_rows" integer DEFAULT 0 NOT NULL,
	"column_mapping" jsonb,
	"started_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- ingestion_receipts — idempotency for every automated write
-- ---------------------------------------------------------------------------
-- Every automated caller retries. Without a receipt, a retried submission
-- creates a second acquisition and inflates the exact metric this product is
-- sold on.
--
-- `request_digest` is a DIGEST, never the payload: a raw request stored here
-- would be a second copy of customer PII in a table nobody thinks of as
-- customer data — outside erasure's reach (ADR-0021 §4).
CREATE TABLE "ingestion_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"external_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"contact_id" uuid,
	"acquisition_id" uuid,
	"opportunity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- contacts: merge and erasure tombstones
-- ---------------------------------------------------------------------------
-- Three distinct inactive states, kept separate on purpose:
--   deleted_at             "removed from my list"        — recoverable
--   merged_into_contact_id "this person is that person"  — a redirect
--   erased_at              "identity is gone"            — irreversible
-- Conflating any pair makes "why did this contact vanish?" unanswerable.
--
-- The identity indexes are rebuilt below to exclude merged and erased rows.
-- THIS MATTERS MORE THAN IT LOOKS: they are what deduplication and ingestion
-- match against. A merge tombstone still holds the duplicate's email until it
-- is folded in, and matching against it would attach new acquisitions to a
-- redirect instead of to the real person.
DROP INDEX "contacts_workspace_email_idx";--> statement-breakpoint
DROP INDEX "contacts_workspace_phone_idx";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "merged_into_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "merged_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "erased_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_field_definitions" ADD CONSTRAINT "contact_field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_field_definitions" ADD CONSTRAINT "contact_field_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_field_values" ADD CONSTRAINT "contact_field_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_field_values" ADD CONSTRAINT "contact_field_values_definition_id_contact_field_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."contact_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_field_values" ADD CONSTRAINT "contact_field_values_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_field_values" ADD CONSTRAINT "contact_field_values_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tagged_by_user_id_users_id_fk" FOREIGN KEY ("tagged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_field_definitions_workspace_key_unique" ON "contact_field_definitions" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "contact_field_definitions_workspace_position_idx" ON "contact_field_definitions" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_field_values_definition_contact_unique" ON "contact_field_values" USING btree ("definition_id","contact_id");--> statement-breakpoint
CREATE INDEX "contact_field_values_contact_idx" ON "contact_field_values" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_field_values_workspace_idx" ON "contact_field_values" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_tags_contact_tag_unique" ON "contact_tags" USING btree ("contact_id","tag_id");--> statement-breakpoint
CREATE INDEX "contact_tags_workspace_tag_idx" ON "contact_tags" USING btree ("workspace_id","tag_id");--> statement-breakpoint
CREATE INDEX "contact_tags_contact_idx" ON "contact_tags" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_workspace_slug_unique" ON "tags" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "tags_workspace_idx" ON "tags" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "erasure_requests_workspace_completed_idx" ON "erasure_requests" USING btree ("workspace_id","completed_at");--> statement-breakpoint
CREATE INDEX "erasure_requests_contact_idx" ON "erasure_requests" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "import_batches_workspace_started_idx" ON "import_batches" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_receipts_workspace_source_key_unique" ON "ingestion_receipts" USING btree ("workspace_id","source_system","external_key");--> statement-breakpoint
CREATE INDEX "ingestion_receipts_workspace_created_idx" ON "ingestion_receipts" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_contact_id_contacts_id_fk" FOREIGN KEY ("merged_into_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_by_user_id_users_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_erased_by_user_id_users_id_fk" FOREIGN KEY ("erased_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_merged_into_idx" ON "contacts" USING btree ("merged_into_contact_id") WHERE "contacts"."merged_into_contact_id" is not null;--> statement-breakpoint
CREATE INDEX "contacts_workspace_email_idx" ON "contacts" USING btree ("workspace_id","email_normalised") WHERE "contacts"."deleted_at" is null and "contacts"."merged_at" is null and "contacts"."erased_at" is null and "contacts"."email_normalised" is not null;--> statement-breakpoint
CREATE INDEX "contacts_workspace_phone_idx" ON "contacts" USING btree ("workspace_id","phone_e164") WHERE "contacts"."deleted_at" is null and "contacts"."merged_at" is null and "contacts"."erased_at" is null and "contacts"."phone_e164" is not null;

-- A contact cannot be merged into itself. Cheap to state, and the failure it
-- prevents (a self-referential redirect) is an infinite loop in the API.
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_merge_target_is_not_self"
  CHECK ("merged_into_contact_id" IS NULL OR "merged_into_contact_id" <> "id");

-- The two halves of the tombstone must be set together, or a merged contact
-- becomes invisible with no redirect — the worst of both states.
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_merge_tombstone_is_complete"
  CHECK (("merged_at" IS NULL) = ("merged_into_contact_id" IS NULL));

-- EXACTLY ONE typed column carries a custom field value.
--
-- Without this, a `number` field could hold both a number and a stale string
-- from before its type changed, and any reader would have to guess which is
-- authoritative. It is also what stops "cleared" and "never set" becoming two
-- indistinguishable states: clearing a value DELETES the row, because nulling
-- all four columns is not a representable row.
ALTER TABLE "contact_field_values"
  ADD CONSTRAINT "contact_field_values_exactly_one_value"
  CHECK (num_nonnulls("value_text", "value_number", "value_boolean", "value_date") = 1);

COMMENT ON TABLE "erasure_requests" IS
  'Permanent, PII-free log of completed erasures. Exists so erasures can be replayed after a backup restore. See ADR-0020.';
COMMENT ON TABLE "ingestion_receipts" IS
  'Idempotency receipts. Stores a request digest, never the payload. See ADR-0021.';

-- =============================================================================
-- Row-level security for every new table
-- =============================================================================
-- Same checklist as 0003, applied to seven more tables. ENABLE *and* FORCE on
-- every one: ENABLE alone leaves the table owner exempt, which silently makes
-- the whole layer decorative.

ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tags_tenant_select ON "tags"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY tags_tenant_insert ON "tags"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY tags_tenant_update ON "tags"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
-- No DELETE policy: tags archive. Deleting one would silently untag every
-- contact that carried it, with no record that it ever existed.

ALTER TABLE "contact_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_tags_tenant_select ON "contact_tags"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY contact_tags_tenant_insert ON "contact_tags"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- DELETE *is* permitted here, unlike everywhere else in the CRM: untagging is
-- ordinary daily work, the row carries no history worth keeping, and the
-- timeline records both the tagging and the untagging anyway.
CREATE POLICY contact_tags_tenant_delete ON "contact_tags"
  FOR DELETE USING (workspace_id = app_current_workspace_id());

ALTER TABLE "contact_field_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_field_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_field_definitions_tenant_select ON "contact_field_definitions"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY contact_field_definitions_tenant_insert ON "contact_field_definitions"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY contact_field_definitions_tenant_update ON "contact_field_definitions"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
-- No DELETE policy: definitions archive, because deleting one would cascade
-- away every value a workspace entered under it.

ALTER TABLE "contact_field_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_field_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_field_values_tenant_select ON "contact_field_values"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY contact_field_values_tenant_insert ON "contact_field_values"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY contact_field_values_tenant_update ON "contact_field_values"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
-- DELETE is how a value is CLEARED — the exactly-one-value CHECK makes
-- "null every column" impossible by design. Erasure uses this path too.
CREATE POLICY contact_field_values_tenant_delete ON "contact_field_values"
  FOR DELETE USING (workspace_id = app_current_workspace_id());

ALTER TABLE "ingestion_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY ingestion_receipts_tenant_select ON "ingestion_receipts"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY ingestion_receipts_tenant_insert ON "ingestion_receipts"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- No UPDATE and no DELETE, deliberately. A receipt that can be rewritten is
-- not an idempotency record — it is a suggestion. Retention pruning, when it
-- exists, runs outside the tenant path with an explicitly elevated role.

ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batches_tenant_select ON "import_batches"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY import_batches_tenant_insert ON "import_batches"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- UPDATE is required: a batch's counters advance as chunks commit.
CREATE POLICY import_batches_tenant_update ON "import_batches"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "erasure_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "erasure_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY erasure_requests_tenant_select ON "erasure_requests"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY erasure_requests_tenant_insert ON "erasure_requests"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- Append-only. The whole value of this table is that it cannot be quietly
-- edited to forget that someone asked to be forgotten.

-- =============================================================================
-- The lifecycle escalation
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: read the current lifecycle operation.
-- -----------------------------------------------------------------------------
-- `missing_ok = true`, so an ordinary transaction yields NULL and every gate
-- below fails closed. STABLE rather than IMMUTABLE for the same reason
-- `app_current_workspace_id()` is: the value changes within a transaction, and
-- letting the planner cache it would be a correctness bug in a security gate.
CREATE OR REPLACE FUNCTION app_lifecycle_operation()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.lifecycle_operation', true), '');
$$;

COMMENT ON FUNCTION app_lifecycle_operation() IS
  'Returns ''merge'', ''erase'' or NULL. Set only inside crm_merge_contacts / crm_erase_contact. See ADR-0019.';

-- -----------------------------------------------------------------------------
-- activities: a narrow, gated UPDATE policy
-- -----------------------------------------------------------------------------
-- The timeline stays append-only for every ordinary code path — no other
-- policy grants UPDATE, and RLS denies what no policy permits. This one
-- additionally requires the lifecycle flag, which nothing in the application
-- sets.
CREATE POLICY activities_lifecycle_update ON "activities"
  FOR UPDATE
  USING (
    workspace_id = app_current_workspace_id()
    AND app_lifecycle_operation() IN ('merge', 'erase')
  )
  WITH CHECK (
    workspace_id = app_current_workspace_id()
    AND app_lifecycle_operation() IN ('merge', 'erase')
  );

-- Even inside a lifecycle operation, only the columns that operation needs may
-- change. The policy says WHO may write; this says WHAT they may write.
--
-- Without it, "merge is allowed to update activities" would mean merge could
-- rewrite a summary, and erasure could re-point a timeline at another person.
CREATE OR REPLACE FUNCTION crm_activities_lifecycle_columns_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation text := app_lifecycle_operation();
BEGIN
  IF operation IS NULL THEN
    -- Unreachable while the RLS policy above is the only UPDATE grant. Kept as
    -- a second, independent statement of the same rule: if the policy is ever
    -- loosened by mistake, this still refuses.
    RAISE EXCEPTION
      'The activity timeline is append-only (ADR-0014).'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id           IS DISTINCT FROM OLD.id
  OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
  OR NEW.type         IS DISTINCT FROM OLD.type
  OR NEW.occurred_at  IS DISTINCT FROM OLD.occurred_at
  OR NEW.created_at   IS DISTINCT FROM OLD.created_at
  OR NEW.actor_type   IS DISTINCT FROM OLD.actor_type
  OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
  THEN
    RAISE EXCEPTION
      'A lifecycle operation may not rewrite when, what or who — only re-home or redact (ADR-0019 §4).'
      USING ERRCODE = 'check_violation';
  END IF;

  IF operation = 'merge' THEN
    -- Re-homing only. A merge that could edit a summary would let a
    -- consolidation quietly rewrite history.
    IF NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.detail  IS DISTINCT FROM OLD.detail
    OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
    OR NEW.acquisition_id IS DISTINCT FROM OLD.acquisition_id
    THEN
      RAISE EXCEPTION 'Merge may only re-point activity.contact_id.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF operation = 'erase' THEN
    -- Redaction only. Erasure must not move a timeline entry to another
    -- person while clearing it.
    IF NEW.contact_id     IS DISTINCT FROM OLD.contact_id
    OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
    OR NEW.acquisition_id IS DISTINCT FROM OLD.acquisition_id
    THEN
      RAISE EXCEPTION 'Erasure may only redact activity summary, detail and metadata.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown lifecycle operation %', operation
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_activities_lifecycle_columns_only
  BEFORE UPDATE ON "activities"
  FOR EACH ROW
  EXECUTE FUNCTION crm_activities_lifecycle_columns_only();

-- -----------------------------------------------------------------------------
-- acquisitions: the provenance trigger learns about lifecycle operations
-- -----------------------------------------------------------------------------
-- 0003 froze every provenance column so that qualification could not be used
-- as a back door to rewriting where a lead came from. Merge needs `contact_id`
-- to move, and erasure needs the linkable detail cleared. Both are added as
-- SEPARATE, NARROW exemptions rather than a single blanket bypass:
--
--   merge  → contact_id, and nothing else
--   erase  → channel_detail, metadata, referrer_origin, gclid, fbclid
--
-- The attribution core — source_type, source_platform, confidence, captured_at,
-- the UTM set and search_query — stays frozen under every operation. A merge or
-- an erasure must never be able to change where a lead came from.
--
-- gclid and fbclid ARE cleared by erasure: they are pseudonymous identifiers of
-- the individual that the ad platform can resolve back to a person, which makes
-- them personal data even though they look like plumbing.
CREATE OR REPLACE FUNCTION crm_acquisitions_provenance_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation text := app_lifecycle_operation();
BEGIN
  -- Frozen under EVERY path, lifecycle operations included.
  IF NEW.source_type       IS DISTINCT FROM OLD.source_type
  OR NEW.source_platform   IS DISTINCT FROM OLD.source_platform
  OR NEW.confidence        IS DISTINCT FROM OLD.confidence
  OR NEW.utm_source        IS DISTINCT FROM OLD.utm_source
  OR NEW.utm_medium        IS DISTINCT FROM OLD.utm_medium
  OR NEW.utm_campaign      IS DISTINCT FROM OLD.utm_campaign
  OR NEW.utm_term          IS DISTINCT FROM OLD.utm_term
  OR NEW.utm_content       IS DISTINCT FROM OLD.utm_content
  OR NEW.search_query      IS DISTINCT FROM OLD.search_query
  OR NEW.landing_path      IS DISTINCT FROM OLD.landing_path
  OR NEW.captured_at       IS DISTINCT FROM OLD.captured_at
  OR NEW.workspace_id      IS DISTINCT FROM OLD.workspace_id
  THEN
    RAISE EXCEPTION
      'Acquisition provenance is immutable. Not even a merge or an erasure may change where a lead came from (ADR-0012).'
      USING ERRCODE = 'check_violation';
  END IF;

  IF operation = 'merge' THEN
    -- contact_id may move; the redaction columns may not.
    IF NEW.referrer_origin IS DISTINCT FROM OLD.referrer_origin
    OR NEW.channel_detail  IS DISTINCT FROM OLD.channel_detail
    OR NEW.metadata        IS DISTINCT FROM OLD.metadata
    OR NEW.gclid           IS DISTINCT FROM OLD.gclid
    OR NEW.fbclid          IS DISTINCT FROM OLD.fbclid
    THEN
      RAISE EXCEPTION 'Merge may only re-point acquisition.contact_id.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF operation = 'erase' THEN
    -- The redaction columns may be cleared; contact_id may not move.
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
      RAISE EXCEPTION 'Erasure may not re-point acquisition.contact_id.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Ordinary operation: qualification columns only, exactly as before.
  IF NEW.referrer_origin IS DISTINCT FROM OLD.referrer_origin
  OR NEW.channel_detail  IS DISTINCT FROM OLD.channel_detail
  OR NEW.metadata        IS DISTINCT FROM OLD.metadata
  OR NEW.gclid           IS DISTINCT FROM OLD.gclid
  OR NEW.fbclid          IS DISTINCT FROM OLD.fbclid
  OR NEW.contact_id      IS DISTINCT FROM OLD.contact_id
  THEN
    RAISE EXCEPTION
      'Acquisition provenance is immutable. Only qualification fields may be updated (ADR-0012).'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- crm_merge_contacts
-- =============================================================================
-- Mechanical re-homing ONLY. Conflict resolution, the timeline entry, the audit
-- record and the domain event stay in TypeScript, where they are unit-testable
-- and reviewable — this function exists solely because `activities` and
-- `acquisitions` need an escalation the application role does not otherwise
-- have.
--
-- ⚠️ EVERY statement carries its own `workspace_id = p_workspace` predicate.
-- SECURITY DEFINER runs as the function owner, and if that owner is a superuser
-- then RLS is inert here. The predicates are the control that survives that,
-- so they are not redundant with the policies — they are the point.
CREATE OR REPLACE FUNCTION crm_merge_contacts(
  p_workspace uuid,
  p_survivor uuid,
  p_duplicate uuid,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  moved_acquisitions  integer := 0;
  moved_opportunities integer := 0;
  moved_tasks         integer := 0;
  moved_activities    integer := 0;
  moved_tags          integer := 0;
  moved_fields        integer := 0;
  survivor_deleted    timestamptz;
  survivor_merged     timestamptz;
  survivor_erased     timestamptz;
  duplicate_merged    timestamptz;
  duplicate_erased    timestamptz;
BEGIN
  -- The caller's tenant scope is authoritative. A function that accepted any
  -- p_workspace would be a cross-tenant write primitive reachable from every
  -- request, which is precisely the hole SECURITY DEFINER is famous for.
  IF p_workspace IS DISTINCT FROM app_current_workspace_id() THEN
    RAISE EXCEPTION 'Merge attempted outside the active workspace scope.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_survivor = p_duplicate THEN
    RAISE EXCEPTION 'A contact cannot be merged into itself.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lock both rows before touching anything. Two operators merging the same
  -- pair in opposite directions at the same moment would otherwise produce two
  -- tombstones pointing at each other.
  --
  -- Locked in id order, not argument order: consistent ordering is what stops
  -- A→B and B→A deadlocking against each other.
  PERFORM 1 FROM contacts
   WHERE workspace_id = p_workspace AND id IN (p_survivor, p_duplicate)
   ORDER BY id
     FOR UPDATE;

  SELECT deleted_at, merged_at, erased_at
    INTO survivor_deleted, survivor_merged, survivor_erased
    FROM contacts WHERE workspace_id = p_workspace AND id = p_survivor;
  -- FOUND rather than a NULL check on a column: every one of these columns is
  -- legitimately NULL for a healthy contact, so "no row" and "a live contact"
  -- would be indistinguishable otherwise.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Both contacts must exist in this workspace.'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT merged_at, erased_at
    INTO duplicate_merged, duplicate_erased
    FROM contacts WHERE workspace_id = p_workspace AND id = p_duplicate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Both contacts must exist in this workspace.'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF survivor_merged IS NOT NULL OR duplicate_merged IS NOT NULL THEN
    RAISE EXCEPTION 'A contact that has already been merged cannot be merged again.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF survivor_erased IS NOT NULL OR duplicate_erased IS NOT NULL THEN
    -- Merging into or out of an erased contact would resurrect identity that
    -- someone asked to have removed.
    RAISE EXCEPTION 'An erased contact cannot take part in a merge.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF survivor_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'The surviving contact must be live.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.lifecycle_operation', 'merge', true);

  UPDATE acquisitions SET contact_id = p_survivor
   WHERE workspace_id = p_workspace AND contact_id = p_duplicate;
  GET DIAGNOSTICS moved_acquisitions = ROW_COUNT;

  UPDATE opportunities SET contact_id = p_survivor, updated_at = now()
   WHERE workspace_id = p_workspace AND contact_id = p_duplicate;
  GET DIAGNOSTICS moved_opportunities = ROW_COUNT;

  UPDATE tasks SET contact_id = p_survivor, updated_at = now()
   WHERE workspace_id = p_workspace AND contact_id = p_duplicate;
  GET DIAGNOSTICS moved_tasks = ROW_COUNT;

  UPDATE activities SET contact_id = p_survivor
   WHERE workspace_id = p_workspace AND contact_id = p_duplicate;
  GET DIAGNOSTICS moved_activities = ROW_COUNT;

  -- Tags: drop the ones the survivor already carries, then move the rest.
  -- Doing it in this order lets the unique index stay a real constraint
  -- instead of something application code has to remember to respect.
  DELETE FROM contact_tags dup
   WHERE dup.workspace_id = p_workspace
     AND dup.contact_id = p_duplicate
     AND EXISTS (
       SELECT 1 FROM contact_tags keep
        WHERE keep.workspace_id = p_workspace
          AND keep.contact_id = p_survivor
          AND keep.tag_id = dup.tag_id
     );

  UPDATE contact_tags SET contact_id = p_survivor
   WHERE workspace_id = p_workspace AND contact_id = p_duplicate;
  GET DIAGNOSTICS moved_tags = ROW_COUNT;

  -- Custom fields: the survivor's value wins; the duplicate's value fills a
  -- gap. Filling a NULL is a strict gain with no information loss, which is
  -- the same rule the service applies to the contact's own columns.
  DELETE FROM contact_field_values dup
   WHERE dup.workspace_id = p_workspace
     AND dup.contact_id = p_duplicate
     AND EXISTS (
       SELECT 1 FROM contact_field_values keep
        WHERE keep.workspace_id = p_workspace
          AND keep.contact_id = p_survivor
          AND keep.definition_id = dup.definition_id
     );

  UPDATE contact_field_values SET contact_id = p_survivor, updated_at = now()
   WHERE workspace_id = p_workspace AND contact_id = p_duplicate;
  GET DIAGNOSTICS moved_fields = ROW_COUNT;

  UPDATE contacts
     SET merged_into_contact_id = p_survivor,
         merged_at = now(),
         merged_by_user_id = p_actor,
         updated_at = now()
   WHERE workspace_id = p_workspace AND id = p_duplicate;

  -- Clear the flag on the way out. It is transaction-local, so leaving it set
  -- would silently extend the escalation to the rest of the caller's
  -- transaction — the exact thing this design is trying to prevent.
  PERFORM set_config('app.lifecycle_operation', '', true);

  RETURN jsonb_build_object(
    'acquisitions',  moved_acquisitions,
    'opportunities', moved_opportunities,
    'tasks',         moved_tasks,
    'activities',    moved_activities,
    'tags',          moved_tags,
    'customFields',  moved_fields
  );
END;
$$;

COMMENT ON FUNCTION crm_merge_contacts(uuid, uuid, uuid, uuid) IS
  'Re-homes every row owned by a duplicate contact onto the survivor and marks the duplicate as a merge tombstone. The ONLY sanctioned path that mutates activities.contact_id. See ADR-0019.';

-- =============================================================================
-- crm_erase_contact
-- =============================================================================
-- Anonymises identity IN PLACE and leaves the commercial record standing.
--
-- Deleting the contact would cascade to acquisitions, opportunities, tasks and
-- activities, destroying revenue and channel history that is a business fact
-- about the workspace rather than personal data about the individual. So the
-- shape of the commercial record survives and only the *who* is removed:
-- "12 leads from organic search, 3 became customers, $14k" still answers.
CREATE OR REPLACE FUNCTION crm_erase_contact(
  p_workspace uuid,
  p_contact uuid,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  erased_acquisitions integer := 0;
  erased_opportunities integer := 0;
  erased_tasks integer := 0;
  erased_activities integer := 0;
  erased_fields integer := 0;
  erased_tags integer := 0;
  already_erased_at timestamptz;
  counts jsonb;
BEGIN
  IF p_workspace IS DISTINCT FROM app_current_workspace_id() THEN
    RAISE EXCEPTION 'Erasure attempted outside the active workspace scope.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT erased_at INTO already_erased_at
    FROM contacts
   WHERE workspace_id = p_workspace AND id = p_contact
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact not found in this workspace.'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF already_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'This contact has already been erased.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.lifecycle_operation', 'erase', true);

  -- Identity. Overwritten, not moved aside — there is deliberately no path
  -- back, which is the entire point of the operation.
  UPDATE contacts
     SET first_name = 'Erased',
         last_name = 'contact',
         email = NULL,
         email_normalised = NULL,
         phone = NULL,
         phone_e164 = NULL,
         erased_at = now(),
         erased_by_user_id = p_actor,
         updated_at = now()
   WHERE workspace_id = p_workspace AND id = p_contact;

  -- Provenance: the channel survives, the linkable detail does not.
  -- source_type, platform, confidence, UTM and landing_path are untouched, so
  -- attribution keeps working after the person is gone.
  UPDATE acquisitions
     SET channel_detail = NULL,
         referrer_origin = NULL,
         metadata = NULL,
         gclid = NULL,
         fbclid = NULL
   WHERE workspace_id = p_workspace AND contact_id = p_contact;
  GET DIAGNOSTICS erased_acquisitions = ROW_COUNT;

  -- Commercial rows keep value, currency, stage, status and dates. Only the
  -- free text, which may carry a name, is replaced.
  UPDATE opportunities
     SET title = 'Erased opportunity', updated_at = now()
   WHERE workspace_id = p_workspace AND contact_id = p_contact;
  GET DIAGNOSTICS erased_opportunities = ROW_COUNT;

  -- ⚠️ REACHED VIA THE OPPORTUNITY AS WELL AS DIRECTLY.
  --
  -- `tasks.contact_id` and `tasks.opportunity_id` are independently nullable,
  -- so a task raised against a deal carries `contact_id = NULL` while its
  -- title is still "Call Sarah about the hot water quote". Keying erasure on
  -- `contact_id` alone would leave that behind — and report success.
  UPDATE tasks
     SET title = 'Erased task', description = NULL, updated_at = now()
   WHERE workspace_id = p_workspace
     AND (
       contact_id = p_contact
       OR opportunity_id IN (
         SELECT id FROM opportunities
          WHERE workspace_id = p_workspace AND contact_id = p_contact
       )
     );
  GET DIAGNOSTICS erased_tasks = ROW_COUNT;

  -- The timeline keeps its shape — what kind of thing happened, and when —
  -- and loses its wording. `type` is retained so the UI can still render the
  -- event, which is why a neutral fixed phrase is enough here.
  --
  -- Free text is NULLED rather than pattern-scrubbed: a regex that misses one
  -- occurrence leaves PII behind while reporting success (ADR-0020 §7).
  --
  -- Same three-way reach as tasks. An activity written for an
  -- opportunity-only task has no contact_id at all, and `summary` embeds the
  -- task title verbatim.
  UPDATE activities
     SET summary = 'Details erased',
         detail = NULL,
         metadata = NULL
   WHERE workspace_id = p_workspace
     AND (
       contact_id = p_contact
       OR opportunity_id IN (
         SELECT id FROM opportunities
          WHERE workspace_id = p_workspace AND contact_id = p_contact
       )
       OR acquisition_id IN (
         SELECT id FROM acquisitions
          WHERE workspace_id = p_workspace AND contact_id = p_contact
       )
     );
  GET DIAGNOSTICS erased_activities = ROW_COUNT;

  -- Custom field values are deleted outright. They are the least predictable
  -- PII in the system — a workspace may have created "Patient Type" or "Case
  -- Number" — so there is no neutral placeholder that is safe in general.
  DELETE FROM contact_field_values
   WHERE workspace_id = p_workspace AND contact_id = p_contact;
  GET DIAGNOSTICS erased_fields = ROW_COUNT;

  -- Tag assignments go too. The vocabulary is workspace configuration, but
  -- "which tags were applied to this person" is a statement about the person.
  DELETE FROM contact_tags
   WHERE workspace_id = p_workspace AND contact_id = p_contact;
  GET DIAGNOSTICS erased_tags = ROW_COUNT;

  counts := jsonb_build_object(
    'acquisitions',  erased_acquisitions,
    'opportunities', erased_opportunities,
    'tasks',         erased_tasks,
    'activities',    erased_activities,
    'customFields',  erased_fields,
    'tags',          erased_tags
  );

  -- The permanent record. Written INSIDE the same transaction: an erasure that
  -- committed without its log entry could not be replayed after a restore, and
  -- a log entry without the erasure would be a lie.
  INSERT INTO erasure_requests (workspace_id, contact_id, requested_by_user_id, affected_counts)
  VALUES (p_workspace, p_contact, p_actor, counts);

  PERFORM set_config('app.lifecycle_operation', '', true);

  RETURN counts;
END;
$$;

COMMENT ON FUNCTION crm_erase_contact(uuid, uuid, uuid) IS
  'Irreversibly anonymises a contact in place, preserving the commercial record. Writes a permanent PII-free erasure_requests row. See ADR-0020.';

-- The application role needs to CALL these; it must never own them. EXECUTE is
-- granted to PUBLIC by default in PostgreSQL, so this is stated explicitly to
-- make the intent reviewable rather than inherited.
REVOKE ALL ON FUNCTION crm_merge_contacts(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_erase_contact(uuid, uuid, uuid) FROM PUBLIC;

-- The restricted roles are provisioned outside migrations
-- (infrastructure/create-app-role.sql), so a fresh database may legitimately be
-- migrated before they exist. Granting to whichever are present, and WARNING
-- loudly otherwise, avoids the two bad outcomes: a migration that fails on a
-- clean checkout, and a function that is silently ungranted until someone
-- reports that "merge does nothing in production".
DO $$
DECLARE
  role_name text;
  granted boolean := false;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['growth_os_app', 'growth_os_app_test'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION crm_merge_contacts(uuid, uuid, uuid, uuid) TO %I', role_name);
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION crm_erase_contact(uuid, uuid, uuid) TO %I', role_name);
      granted := true;
    END IF;
  END LOOP;

  IF NOT granted THEN
    RAISE WARNING 'No restricted application role found; grant EXECUTE on crm_merge_contacts and crm_erase_contact after provisioning one (infrastructure/create-app-role.sql).';
  END IF;
END
$$;

COMMENT ON COLUMN "contacts"."merged_into_contact_id" IS
  'Redirect target. Set means this contact IS the target. Distinct from deleted_at. See ADR-0019.';
COMMENT ON COLUMN "contacts"."erased_at" IS
  'Identity irreversibly anonymised. The commercial record deliberately survives. See ADR-0020.';
