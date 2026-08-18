-- =============================================================================
-- The frontier's URL bound, and two skip reasons the enum could not express
-- =============================================================================
-- Stage 4. Three things recorded and deliberately deferred across ADR-0038 and
-- ADR-0039, each named at the time as belonging with the others because each
-- needs this one migration. They are three symptoms of the same gap: the
-- database not backing up what the application had already decided.
--
-- Hand-written, not Drizzle-generated. Drizzle Kit does not model CHECK
-- constraints, and it would generate the enum change as a type rewrite.
--
-- ⚠️ WHAT THIS MIGRATION DOES AND DOES NOT DO WITH THE ENUM
-- Measured on this server (PostgreSQL 18.4) rather than assumed:
--
--   ALTER TYPE ... ADD VALUE inside a transaction   -- WORKS (PostgreSQL 12+)
--   using that value in the SAME transaction        -- ERROR: unsafe use of
--                                                   -- new value ... and the
--                                                   -- whole transaction rolls
--                                                   -- back
--   ADD VALUE IF NOT EXISTS, re-run                 -- idempotent, NOTICE only
--
-- The migration runner wraps each file in a transaction, so this file ADDS the
-- two values and NEVER USES THEM. No INSERT, no comparison, no CHECK mentioning
-- them. A migration that seeded a row with `url_too_long` would fail here and
-- take the schema change down with it.
--
-- Before PostgreSQL 12 the ADD VALUE itself could not run in a transaction at
-- all. That is not this server, and the engines field pins Node rather than
-- PostgreSQL, so `IF NOT EXISTS` is used to keep the file re-runnable rather
-- than to work around a version.
--
-- @see docs/decisions/ADR-0042-frontier-bound-and-precise-skip-reasons.md

-- -----------------------------------------------------------------------------
-- 1. crawl_frontier.normalised_url was the only one of the three unbounded
-- -----------------------------------------------------------------------------
-- `crawl_pages.normalised_url` and `site_pages.normalised_url` have carried
-- CHECK (<> '' AND length <= 2048) since 0008. `crawl_frontier.normalised_url`
-- was a bare `text NOT NULL` — and `enqueueDiscovered` writes to
-- `crawl_frontier`, so the one table on the write path was the one with no
-- backstop. AGENTS.md §5: limits live in the database.
--
-- 2048 is `MAX_URL_LENGTH` in @growth-os/net, which `normaliseUrl` imports and
-- never redeclares. The number appears here a third time because a CHECK cannot
-- import; the two that must agree are this file and 0008, and they do.
ALTER TABLE "crawl_frontier"
  ADD CONSTRAINT "crawl_frontier_url_is_bounded"
  CHECK ("normalised_url" <> '' AND length("normalised_url") <= 2048);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. url_too_long — ADR-0038
-- -----------------------------------------------------------------------------
-- An over-length URL was recorded as `unsupported_scheme`, the label every
-- `normaliseUrl → null` received. It says "this is a mailto:" about an ordinary
-- page whose only problem is length.
ALTER TYPE "public"."crawl_skip_reason" ADD VALUE IF NOT EXISTS 'url_too_long';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. budget_exhausted — ADR-0039
-- -----------------------------------------------------------------------------
-- A URL refused because the robots matcher's step budget ran out was recorded
-- as `robots_disallowed`, which asserts that a rule the site owner wrote decided
-- it. It did not; our budget did, and we refused rather than guess whether any
-- rule matched. The RobotsVerdict has carried the distinction since ADR-0039 and
-- the frontier row could not express it. AGENTS.md §5: a skip reason records
-- what happened, never a judgement about the file.
ALTER TYPE "public"."crawl_skip_reason" ADD VALUE IF NOT EXISTS 'budget_exhausted';
