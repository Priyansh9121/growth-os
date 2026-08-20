-- The three Growth palettes join the theme vocabulary, and `growth-bright`
-- becomes the default for accounts created from now on.
--
-- ⚠️ THIS REPLACES THE TYPE INSTEAD OF USING `ALTER TYPE ... ADD VALUE`, AND
-- THAT IS FORCED, NOT STYLISTIC.
--
-- PostgreSQL refuses to USE a value in the transaction that added it:
--
--   ERROR:  unsafe use of new value "growth-bright" of enum type theme_preference
--   HINT:   New enum values must be committed before they can be used.
--
-- Migrations 0009, 0010 and 0011 all used ADD VALUE safely because nothing
-- consumed the new value in the same run. This is the first migration that must
-- immediately SET DEFAULT to one, so the rule finally bites.
--
-- Splitting it across two migration files does NOT help, which was measured
-- rather than assumed: drizzle applies every pending migration inside ONE
-- transaction, so a second file rolled the first one back with it. On a fresh
-- database — §7.2's from-zero run — all fourteen migrations share a single
-- transaction, so no amount of file-splitting could ever work.
--
-- Recreating the type is the standard answer and is transaction-safe, because
-- `CREATE TYPE` (unlike `ADD VALUE`) is usable immediately. Existing rows carry
-- across through a `::text` cast, so `dark` stays `dark`.
--
-- ⚠️ THE DEFAULT CHANGE MOVES NOBODY, AND THAT IS THE POINT.
-- A column DEFAULT applies only to an INSERT that omits the column.
-- `theme_preference` is NOT NULL (0012), so every account that already exists
-- is stored with an explicit value — `dark` for anyone who never opened the
-- settings page. Verified on a throwaway database: a row written before the
-- default changed still read `dark` afterwards; one written after read
-- `growth-bright`. The dev database holds 2 accounts on `dark` and 1 on
-- `light`, all explicit, no nulls.
--
-- The consequence, stated rather than discovered later: users on the old
-- default do not receive the new one. Nothing distinguishes "chose dark" from
-- "never chose", so a backfill would silently re-theme people who had actually
-- picked dark. ADR-0057 records leaving them as the deliberate choice.
--
-- @see docs/decisions/ADR-0057-growth-theme-palettes.md

-- The default references the old type, so it must go before the type does.
ALTER TABLE "users" ALTER COLUMN "theme_preference" DROP DEFAULT;
--> statement-breakpoint

CREATE TYPE "public"."theme_preference_new" AS ENUM(
  'dark', 'light', 'growth-bright', 'growth-dark', 'growth-warm'
);
--> statement-breakpoint

ALTER TABLE "users"
  ALTER COLUMN "theme_preference" TYPE "public"."theme_preference_new"
  USING "theme_preference"::text::"public"."theme_preference_new";
--> statement-breakpoint

DROP TYPE "public"."theme_preference";
--> statement-breakpoint

ALTER TYPE "public"."theme_preference_new" RENAME TO "theme_preference";
--> statement-breakpoint

ALTER TABLE "users"
  ALTER COLUMN "theme_preference" SET DEFAULT 'growth-bright';
