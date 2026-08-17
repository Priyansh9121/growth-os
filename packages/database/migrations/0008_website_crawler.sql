CREATE TYPE "public"."site_verification_method" AS ENUM('html_meta', 'dns_txt');--> statement-breakpoint
CREATE TYPE "public"."crawl_failure_category" AS ENUM('ssrf_blocked', 'dns_failure', 'connect_failed', 'connect_timeout', 'headers_timeout', 'body_timeout', 'total_timeout', 'tls_error', 'protocol_error', 'redirect_limit', 'redirect_refused', 'response_too_large', 'unsupported_content_type', 'decode_error', 'scheme_not_allowed', 'credentials_present', 'port_not_allowed', 'host_missing', 'host_too_long', 'url_too_long', 'sensitive_query', 'unparseable', 'cancelled', 'robots_blocked', 'parse_error', 'http_4xx', 'http_5xx');--> statement-breakpoint
CREATE TYPE "public"."crawl_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."crawl_trigger" AS ENUM('manual', 'scheduled', 'recrawl');--> statement-breakpoint
CREATE TYPE "public"."frontier_state" AS ENUM('discovered', 'queued', 'fetching', 'fetched', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."indexability_state" AS ENUM('indexable', 'noindex_meta', 'noindex_header', 'robots_disallowed', 'non_canonical', 'not_200');--> statement-breakpoint
CREATE TYPE "public"."link_scope" AS ENUM('internal', 'external', 'other_subdomain');--> statement-breakpoint
CREATE TYPE "public"."page_fetch_outcome" AS ENUM('fetched', 'unchanged', 'redirected', 'http_4xx', 'http_5xx', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."robots_outcome" AS ENUM('fetched', 'absent', 'forbidden', 'unavailable', 'error');--> statement-breakpoint
CREATE TYPE "public"."sitemap_outcome" AS ENUM('fetched', 'absent', 'error', 'truncated', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."crawl_skip_reason" AS ENUM('robots_disallowed', 'out_of_scope', 'external', 'other_subdomain', 'page_limit', 'depth_limit', 'sensitive_url', 'unsupported_scheme', 'cancelled');--> statement-breakpoint
CREATE TABLE "crawl_frontier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"normalised_url" text NOT NULL,
	"state" "frontier_state" DEFAULT 'discovered' NOT NULL,
	"skip_reason" "crawl_skip_reason",
	"depth" smallint DEFAULT 0 NOT NULL,
	"discovered_from" uuid,
	"discovery_source" text DEFAULT 'link' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"source_page_id" uuid NOT NULL,
	"target_url" text NOT NULL,
	"scope" "link_scope" NOT NULL,
	"anchor_text" text,
	"is_nofollow" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"site_page_id" uuid,
	"normalised_url" text NOT NULL,
	"depth" smallint DEFAULT 0 NOT NULL,
	"outcome" "page_fetch_outcome" NOT NULL,
	"failure_category" "crawl_failure_category",
	"http_status" smallint,
	"content_type" text,
	"content_length" integer,
	"fetch_duration_ms" integer,
	"final_url" text,
	"redirect_count" smallint DEFAULT 0 NOT NULL,
	"etag" text,
	"last_modified" text,
	"content_hash" text,
	"title" text,
	"meta_description" text,
	"canonical_url" text,
	"robots_meta" text,
	"x_robots_tag" text,
	"html_lang" text,
	"h1_count" smallint,
	"h1_text" text,
	"h2_count" smallint,
	"word_count" integer,
	"internal_link_count" smallint,
	"external_link_count" smallint,
	"image_count" smallint,
	"images_missing_alt_count" smallint,
	"structured_data_types" jsonb,
	"hreflang_values" jsonb,
	"has_open_graph" boolean DEFAULT false NOT NULL,
	"has_viewport" boolean DEFAULT false NOT NULL,
	"indexability" "indexability_state",
	"extraction_truncated" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"status" "crawl_status" DEFAULT 'queued' NOT NULL,
	"trigger" "crawl_trigger" NOT NULL,
	"origin" text NOT NULL,
	"page_limit" integer NOT NULL,
	"max_depth" smallint NOT NULL,
	"robots_outcome" "robots_outcome",
	"sitemap_outcome" "sitemap_outcome",
	"sitemap_url_count" integer DEFAULT 0 NOT NULL,
	"pages_discovered" integer DEFAULT 0 NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"pages_failed" integer DEFAULT 0 NOT NULL,
	"pages_skipped" integer DEFAULT 0 NOT NULL,
	"bytes_downloaded" integer DEFAULT 0 NOT NULL,
	"failure_category" "crawl_failure_category",
	"failure_detail" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"normalised_url" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "verification_token_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "verification_method" "site_verification_method";--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "verification_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "crawl_page_limit" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "crawl_max_depth" smallint DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "crawl_concurrency" smallint DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "crawl_delay_ms" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_frontier" ADD CONSTRAINT "crawl_frontier_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_frontier" ADD CONSTRAINT "crawl_frontier_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_frontier" ADD CONSTRAINT "crawl_frontier_discovered_from_crawl_frontier_id_fk" FOREIGN KEY ("discovered_from") REFERENCES "public"."crawl_frontier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_source_page_id_crawl_pages_id_fk" FOREIGN KEY ("source_page_id") REFERENCES "public"."crawl_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_site_page_id_site_pages_id_fk" FOREIGN KEY ("site_page_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_frontier_crawl_url_unique" ON "crawl_frontier" USING btree ("crawl_id","normalised_url");--> statement-breakpoint
CREATE INDEX "crawl_frontier_claim_idx" ON "crawl_frontier" USING btree ("crawl_id","state","created_at");--> statement-breakpoint
CREATE INDEX "crawl_links_source_idx" ON "crawl_links" USING btree ("crawl_id","source_page_id");--> statement-breakpoint
CREATE INDEX "crawl_links_target_idx" ON "crawl_links" USING btree ("crawl_id","target_url");--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_pages_crawl_url_unique" ON "crawl_pages" USING btree ("crawl_id","normalised_url");--> statement-breakpoint
CREATE INDEX "crawl_pages_crawl_idx" ON "crawl_pages" USING btree ("workspace_id","crawl_id","normalised_url");--> statement-breakpoint
CREATE INDEX "crawl_pages_site_page_idx" ON "crawl_pages" USING btree ("site_page_id","fetched_at");--> statement-breakpoint
CREATE INDEX "crawl_pages_site_url_idx" ON "crawl_pages" USING btree ("site_id","normalised_url","fetched_at");--> statement-breakpoint
CREATE INDEX "crawl_pages_status_idx" ON "crawl_pages" USING btree ("crawl_id","http_status");--> statement-breakpoint
CREATE INDEX "crawls_site_created_idx" ON "crawls" USING btree ("workspace_id","site_id","created_at");--> statement-breakpoint
CREATE INDEX "crawls_status_idx" ON "crawls" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_pages_site_url_unique" ON "site_pages" USING btree ("site_id","normalised_url");--> statement-breakpoint
CREATE INDEX "site_pages_workspace_idx" ON "site_pages" USING btree ("workspace_id","site_id","last_seen_at");-- =============================================================================
-- Hand-written half: constraints and row-level security
-- =============================================================================
-- Everything above was generated from the Drizzle schema. Everything below is
-- written by hand, because Drizzle emits no CHECK constraints and no policies —
-- and those are where a multi-tenant crawler's guarantees actually live.

-- -----------------------------------------------------------------------------
-- CHECK constraints: states that must not be representable
-- -----------------------------------------------------------------------------

-- A verification token is 128 bits of hex, exactly as a form's public key is.
-- Enforced here as well as in the generator, because the constraint has to hold
-- for a row a future importer or a hand-written fix writes too.
ALTER TABLE "sites"
  ADD CONSTRAINT "sites_verification_token_is_high_entropy"
  CHECK ("verification_token" IS NULL OR "verification_token" ~ '^[0-9a-f]{32}$');

-- A site is verified, or it has a verified_at. Never one without the other:
-- a `verified` row with no timestamp cannot be audited, and a timestamp on an
-- `unverified` row reads as a verification that was silently revoked.
ALTER TABLE "sites"
  ADD CONSTRAINT "sites_verified_state_matches_timestamp"
  CHECK (
    ("verification_state" = 'verified' AND "verified_at" IS NOT NULL AND "verification_method" IS NOT NULL)
    OR ("verification_state" <> 'verified' AND "verified_at" IS NULL)
  );

-- ⚠️ CRAWL BUDGETS ARE BOUNDED IN THE DATABASE, NOT ONLY IN THE UI.
--
-- These decide how hard somebody else's server is asked to work. A page limit
-- set to 2,000,000 through a bug, a bad migration or a hand-edited row is a
-- denial-of-service tool with our name on the user agent — so the ceiling lives
-- where no application path can route around it.
--
-- The upper bounds are deliberately generous relative to the 500-page default
-- and deliberately finite.
ALTER TABLE "sites"
  ADD CONSTRAINT "sites_crawl_budget_is_bounded"
  CHECK (
    "crawl_page_limit" BETWEEN 1 AND 10000
    AND "crawl_max_depth" BETWEEN 1 AND 20
    AND "crawl_concurrency" BETWEEN 1 AND 4
    AND "crawl_delay_ms" BETWEEN 0 AND 60000
  );

ALTER TABLE "crawls"
  ADD CONSTRAINT "crawls_budget_is_bounded"
  CHECK ("page_limit" BETWEEN 1 AND 10000 AND "max_depth" BETWEEN 1 AND 20);

-- A finished crawl has an end; a running one has a start. Stating it here stops
-- a half-written lifecycle from being representable at all.
ALTER TABLE "crawls"
  ADD CONSTRAINT "crawls_terminal_status_has_completed_at"
  CHECK (
    ("status" IN ('completed', 'failed', 'cancelled') AND "completed_at" IS NOT NULL)
    OR "status" IN ('queued', 'running')
  );

ALTER TABLE "crawls"
  ADD CONSTRAINT "crawls_running_has_started_at"
  CHECK ("status" = 'queued' OR "started_at" IS NOT NULL);

-- A failed crawl says why, in a category. Without this a crawl can fail with no
-- explanation, which is exactly the state an operator cannot act on.
ALTER TABLE "crawls"
  ADD CONSTRAINT "crawls_failed_has_category"
  CHECK ("status" <> 'failed' OR "failure_category" IS NOT NULL);

-- Counters are counts.
ALTER TABLE "crawls"
  ADD CONSTRAINT "crawls_counters_are_non_negative"
  CHECK (
    "pages_discovered" >= 0 AND "pages_fetched" >= 0
    AND "pages_failed" >= 0 AND "pages_skipped" >= 0
    AND "bytes_downloaded" >= 0 AND "sitemap_url_count" >= 0
  );

-- A skipped frontier entry says why it was skipped, and nothing else carries a
-- skip reason. "We found 900 URLs and fetched 500" is only a usable statement
-- when the other 400 each have an answer attached.
ALTER TABLE "crawl_frontier"
  ADD CONSTRAINT "crawl_frontier_skip_reason_matches_state"
  CHECK (
    ("state" = 'skipped' AND "skip_reason" IS NOT NULL)
    OR ("state" <> 'skipped' AND "skip_reason" IS NULL)
  );

ALTER TABLE "crawl_frontier"
  ADD CONSTRAINT "crawl_frontier_depth_is_bounded"
  CHECK ("depth" BETWEEN 0 AND 20 AND "attempts" BETWEEN 0 AND 10);

-- A page that failed carries a category; a page that succeeded does not. The
-- same rule as `form_submissions_outcome_matches_result` in 0007.
ALTER TABLE "crawl_pages"
  ADD CONSTRAINT "crawl_pages_failure_matches_outcome"
  CHECK (
    ("outcome" IN ('blocked', 'failed') AND "failure_category" IS NOT NULL)
    OR ("outcome" NOT IN ('blocked', 'failed'))
  );

-- An HTTP status is an HTTP status.
ALTER TABLE "crawl_pages"
  ADD CONSTRAINT "crawl_pages_http_status_is_plausible"
  CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599);

-- ⚠️ ANCHOR TEXT IS ARBITRARY PUBLIC CONTENT FROM A THIRD PARTY'S WEBSITE.
-- Capped in the database as well as in the extractor, so a bug in one cannot
-- put a megabyte of somebody's page body into a column.
ALTER TABLE "crawl_links"
  ADD CONSTRAINT "crawl_links_anchor_text_is_bounded"
  CHECK ("anchor_text" IS NULL OR length("anchor_text") <= 300);

ALTER TABLE "crawl_pages"
  ADD CONSTRAINT "crawl_pages_text_fields_are_bounded"
  CHECK (
    ("title" IS NULL OR length("title") <= 1000)
    AND ("meta_description" IS NULL OR length("meta_description") <= 2000)
    AND ("h1_text" IS NULL OR length("h1_text") <= 1000)
    AND ("canonical_url" IS NULL OR length("canonical_url") <= 2048)
    AND ("normalised_url" <> '' AND length("normalised_url") <= 2048)
  );

-- =============================================================================
-- Row-level security
-- =============================================================================
-- ENABLE *and* FORCE on every workspace-owned table. ENABLE alone leaves the
-- table owner exempt, which silently makes the whole layer decorative.
--
-- ⚠️ THE WORKER RUNS AS AN OPERATIONAL ROLE AND STILL GOES THROUGH THESE.
-- A crawl writes customer-owned rows, so every crawler write opens a
-- `withTenantTransaction` exactly as a request handler does. The worker's
-- database access must never become a way around the tenant boundary.

ALTER TABLE "crawls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crawls" FORCE ROW LEVEL SECURITY;
CREATE POLICY crawls_tenant_select ON "crawls"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY crawls_tenant_insert ON "crawls"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY crawls_tenant_update ON "crawls"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
-- No DELETE policy: crawl history is the product. "What changed between crawl
-- 12 and crawl 13?" cannot be answered by a table rows disappear from, and a
-- retention rule for old crawls is a decision nobody has made yet — inventing
-- one so the table looks handled is how customer data gets deleted on a
-- schedule nobody agreed to (the same rule as ADR-0013's open gap).

ALTER TABLE "crawl_frontier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crawl_frontier" FORCE ROW LEVEL SECURITY;
CREATE POLICY crawl_frontier_tenant_select ON "crawl_frontier"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY crawl_frontier_tenant_insert ON "crawl_frontier"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY crawl_frontier_tenant_update ON "crawl_frontier"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "crawl_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crawl_pages" FORCE ROW LEVEL SECURITY;
CREATE POLICY crawl_pages_tenant_select ON "crawl_pages"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY crawl_pages_tenant_insert ON "crawl_pages"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY crawl_pages_tenant_update ON "crawl_pages"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE "crawl_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crawl_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY crawl_links_tenant_select ON "crawl_links"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY crawl_links_tenant_insert ON "crawl_links"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
-- No UPDATE policy: a link is an observation from one crawl, and an observation
-- that can be edited is not evidence. A changed link is a new crawl's row.

-- -----------------------------------------------------------------------------
-- site_pages — the durable page identity
-- -----------------------------------------------------------------------------

-- A URL is a URL, and it is bounded exactly as the observation's is.
ALTER TABLE "site_pages"
  ADD CONSTRAINT "site_pages_url_is_bounded"
  CHECK ("normalised_url" <> '' AND length("normalised_url") <= 2048);

-- Last seen cannot precede first seen. A crawl that wrote them out of order
-- would make "how long has this page existed?" produce a negative number.
ALTER TABLE "site_pages"
  ADD CONSTRAINT "site_pages_seen_range_is_ordered"
  CHECK ("last_seen_at" >= "first_seen_at");

ALTER TABLE "site_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_pages" FORCE ROW LEVEL SECURITY;
CREATE POLICY site_pages_tenant_select ON "site_pages"
  FOR SELECT USING (workspace_id = app_current_workspace_id());
CREATE POLICY site_pages_tenant_insert ON "site_pages"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY site_pages_tenant_update ON "site_pages"
  FOR UPDATE USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());
-- No DELETE policy. A page that disappears from a site is a FACT about the
-- site, recorded as a gap between `last_seen_at` and the latest crawl — not as
-- a row that vanishes. Deleting it would erase the history that makes "this
-- page 404ed last Tuesday" answerable.
