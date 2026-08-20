-- Which palette a person sees.
--
-- The light palette has existed in `packages/ui/src/tokens/tokens.css` since
-- the design system landed, with contrast tests and documentation. Nothing
-- could reach it: the root layout hardcoded `data-theme="dark"`. This column is
-- the missing switch.
--
-- ⚠️ NOT NULL DEFAULT 'dark', WHICH IS THE WHOLE COMPATIBILITY STORY.
-- The default backfills every existing row in this one statement, so every
-- account that exists today keeps exactly the appearance it has today and no
-- account is left with a null the application has to interpret. Nobody sees a
-- changed product until they choose to.
--
-- ⚠️ AN ENUM RATHER THAN TEXT, because AGENTS.md §5 puts limits in the database.
-- The set of valid themes is a constraint, not application validation: a typo
-- in a future route is refused by PostgreSQL rather than stored and rendered as
-- an unstyled page. `THEME_PREFERENCES` in @growth-os/contracts is the same
-- list, and drizzle builds this enum from it so the two cannot drift.
--
-- `auto` is deliberately absent. tokens.css already honours
-- `prefers-color-scheme` when `data-theme` is absent, so following the OS is a
-- value away — but this change is explicit-choice-only, and a value the
-- settings page cannot produce would be a state nothing can clear.
--
-- @see docs/decisions/ADR-0056-user-theme-preference.md
CREATE TYPE "public"."theme_preference" AS ENUM('dark', 'light');
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN "theme_preference" "theme_preference" NOT NULL DEFAULT 'dark';
