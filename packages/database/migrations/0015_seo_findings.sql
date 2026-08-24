-- =============================================================================
-- seo_findings — the first table that holds an interpretation, not an observation
-- =============================================================================
-- Hand-written, not Drizzle-generated — the convention since 0009. Drizzle Kit
-- models neither CHECK constraints nor RLS policies, and both carry the load
-- here. (It also diffs against the 0008 snapshot, the last one generated, so
-- `generate` re-emits every hand-written migration since. Confirmed this
-- session before this file was written by hand instead.)
--
-- ⚠️ THIS IS THE STAGE BOUNDARY IN AGENTS.md §5, MADE INTO A TABLE.
-- `crawl_pages` and `crawl_links` record what a website said. This records what
-- a rule concluded after reading them. Every column below is a measurement or a
-- pointer to what was measured. None of them is a severity, a priority or a
-- sentence of English — those are Stage 5's later deliverables and a UI's copy,
-- and a schema is the wrong place to decide either.
--
-- ⚠️ A FINDING BELONGS TO A CRAWL, exactly as `crawl_pages` does.
-- ADR-0034's test: "if a crawl could observe it differently next time, it is a
-- fact and it belongs to the observation". A finding is derived entirely from
-- one crawl's rows, so it is scoped to that crawl and never overwritten.
--
-- The consequence is why it is worth stating. A page that stops being orphaned
-- needs NOTHING DELETED and nothing updated: the next crawl simply writes no
-- `orphan_page` row for it. "The finding closed between crawl 12 and crawl 13"
-- is then readable from two crawls' rows — which is the roadmap's definition of
-- done for this stage, and it falls out of the lifetime rather than needing a
-- `resolved_at` column that something has to remember to write.
--
-- @see docs/decisions/ADR-0070-findings-belong-to-a-crawl.md
-- @see docs/decisions/ADR-0034-crawl-storage-model.md

CREATE TYPE "public"."seo_finding_rule" AS ENUM('orphan_page');--> statement-breakpoint

CREATE TABLE "seo_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"site_page_id" uuid NOT NULL,
	"rule" "seo_finding_rule" NOT NULL,
	"evidence" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ⚠️ `site_page_id` IS THE DURABLE PAGE, NOT THE OBSERVATION, and it is NOT
-- NULL where `crawl_pages.site_page_id` is nullable.
--
-- Two crawls' findings about the same page share this id, so "still orphaned in
-- March" is a query rather than a string comparison on a URL. Pointing at
-- `crawl_pages` instead would scope the finding's SUBJECT to one crawl as well
-- as its lifetime, leaving nothing to compare across them.
--
-- `crawl_pages.site_page_id` is nullable so a fetch that failed before the URL
-- was resolved still records the attempt. That reasoning does not carry: a
-- finding about no particular page is not a finding.
ALTER TABLE "seo_findings" ADD CONSTRAINT "seo_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_findings" ADD CONSTRAINT "seo_findings_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_findings" ADD CONSTRAINT "seo_findings_site_page_id_site_pages_id_fk" FOREIGN KEY ("site_page_id") REFERENCES "public"."site_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The row bound, which is an index rather than a ceiling
-- -----------------------------------------------------------------------------

-- ⚠️ ONE FINDING PER RULE PER PAGE PER CRAWL — AND THIS IS WHERE THE LIMIT LIVES.
--
-- AGENTS.md §5 puts limits in the database, and the brief for this table asked
-- for "at most N findings per crawl" as a CHECK constraint. A CHECK cannot
-- express it: it is evaluated against one row and cannot count a table. (Nor is
-- there a precedent to copy — `crawl_links` has no row cap either; its only
-- CHECK bounds `anchor_text` to 300 characters.)
--
-- So the bound is structural instead, and it is a real one. A rule writes at
-- most one row per retrieved page; `crawl_pages_crawl_url_unique` allows at
-- most one row per URL per crawl; `crawls_budget_is_bounded` caps `page_limit`
-- at 10,000. One pathological crawl therefore cannot write unbounded findings,
-- and no arbitrary number had to be invented to say so.
--
-- It is also the retry guarantee, exactly as `crawl_pages_crawl_url_unique` is:
-- re-auditing a crawl must be idempotent, not a way to double every finding on
-- it. Writes go through this constraint with ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX "seo_findings_crawl_page_rule_unique" ON "seo_findings" USING btree ("crawl_id","site_page_id","rule");--> statement-breakpoint

-- "What did this crawl find?" — the audit's own read.
CREATE INDEX "seo_findings_crawl_idx" ON "seo_findings" USING btree ("workspace_id","crawl_id","rule");--> statement-breakpoint
-- "Has this page been orphaned before?" — the across-crawls comparison that the
-- durable `site_page_id` exists to make possible.
CREATE INDEX "seo_findings_page_idx" ON "seo_findings" USING btree ("site_page_id","rule","detected_at");--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- CHECK constraints: states that must not be representable
-- -----------------------------------------------------------------------------

-- ⚠️ A FINDING THAT DECIDED NOTHING IS NOT A FINDING.
--
-- `evidence` is `jsonb` because the deciding facts differ per rule —
-- `orphan_page` decides on two integers, and shared `observed`/`population`
-- columns would be a lie for the first rule that decides on a boolean. What a
-- loose column must not become is a nullable bag: `null`, `{}`, a bare number
-- or a string would all satisfy `jsonb NOT NULL` and none of them states what
-- was measured.
--
-- The 4 KB ceiling is the same reasoning as `crawl_links_anchor_text_is_bounded`
-- — a bug in a rule must not be able to put a page of prose in a column, and
-- the place that stops it is the one no application path routes around.
ALTER TABLE "seo_findings"
  ADD CONSTRAINT "seo_findings_evidence_is_a_bounded_object"
  CHECK (
    jsonb_typeof("evidence") = 'object'
    AND "evidence" <> '{}'::jsonb
    AND length("evidence"::text) <= 4096
  );--> statement-breakpoint

-- =============================================================================
-- Row-level security
-- =============================================================================
-- ENABLE *and* FORCE, as every workspace-owned table is. ENABLE alone leaves
-- the table owner exempt, which silently makes the whole layer decorative.

ALTER TABLE "seo_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seo_findings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY seo_findings_tenant_select ON "seo_findings"
  FOR SELECT USING (workspace_id = app_current_workspace_id());--> statement-breakpoint
CREATE POLICY seo_findings_tenant_insert ON "seo_findings"
  FOR INSERT WITH CHECK (workspace_id = app_current_workspace_id());--> statement-breakpoint

-- ⚠️ NO UPDATE POLICY AND NO DELETE POLICY, AND THE TWO HAVE DIFFERENT REASONS.
--
-- No UPDATE: a finding is what a rule concluded from one crawl's facts, and a
-- conclusion that can be edited afterwards is not evidence of anything. If the
-- rule changes its mind, that is a new crawl's row — the same rule
-- `crawl_links` follows.
--
-- No DELETE: a finding that stops being true does not need deleting, because
-- the next crawl simply produces no row for that page. Deleting this crawl's
-- row would erase the half of "the finding closed between crawl 12 and crawl
-- 13" that says it was ever open. Crawl history is the product (0008's
-- `crawls` comment, ADR-0013's open gap); an interpretation of that history
-- inherits the same rule.
