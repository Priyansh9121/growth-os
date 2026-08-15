-- =============================================================================
-- Fix: deleting a user must not be blocked by the append-only trigger
-- =============================================================================
-- THE BUG, AND HOW IT WAS FOUND
-- Migration 0004 added `crm_activities_lifecycle_columns_only`, a BEFORE UPDATE
-- trigger that refuses any update to `activities` outside a lifecycle
-- operation. That is exactly what it should do for application code.
--
-- It also refuses the DATABASE'S OWN referential-integrity cascade.
-- `activities.actor_user_id` is `ON DELETE SET NULL`, so `DELETE FROM users`
-- makes PostgreSQL issue `UPDATE activities SET actor_user_id = NULL` — with no
-- lifecycle flag set, because no application code is involved. The trigger
-- raised, and the delete failed.
--
-- Consequence: **a user who had ever authored a timeline entry could not be
-- deleted.** Every operator authors timeline entries within minutes of using
-- the product, so in practice that was every user. It also broke `db:seed`,
-- which truncates by deleting users — which is how the E2E suite surfaced it,
-- before any other layer could. Unit tests have no cascades; the integration
-- suite truncates with TRUNCATE CASCADE rather than DELETE, so it never fired
-- the trigger either.
--
-- THE FIX, AND WHY IT IS NARROW
-- Permit exactly the shape of a `SET NULL` cascade: `actor_user_id` going from
-- a value to NULL, with EVERY other column unchanged. Nothing else about the
-- row may move, and the row cannot be re-attributed to a different user — only
-- de-attributed, which is what deleting the author means.
--
-- The alternative, dropping `actor_user_id` from the frozen list, would have
-- let a merge or an erasure quietly reassign authorship of history. That is a
-- worse property than the bug.
--
-- @see docs/decisions/ADR-0014-activity-vs-audit.md
-- @see docs/development-log/0010-lifecycle-implementation.md
-- =============================================================================

CREATE OR REPLACE FUNCTION crm_activities_lifecycle_columns_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation text := app_lifecycle_operation();
BEGIN
  -- THE FOREIGN-KEY CASCADE CARVE-OUT.
  --
  -- Recognised by its exact shape rather than by trusting the caller: the only
  -- change is `actor_user_id` becoming NULL. A statement that also touched a
  -- summary, or that pointed the row at a different user, does not match and
  -- falls through to the rules below.
  IF operation IS NULL
     AND OLD.actor_user_id IS NOT NULL
     AND NEW.actor_user_id IS NULL
     AND NEW.id            IS NOT DISTINCT FROM OLD.id
     AND NEW.workspace_id  IS NOT DISTINCT FROM OLD.workspace_id
     AND NEW.type          IS NOT DISTINCT FROM OLD.type
     AND NEW.summary       IS NOT DISTINCT FROM OLD.summary
     AND NEW.detail        IS NOT DISTINCT FROM OLD.detail
     AND NEW.metadata      IS NOT DISTINCT FROM OLD.metadata
     AND NEW.contact_id    IS NOT DISTINCT FROM OLD.contact_id
     AND NEW.opportunity_id IS NOT DISTINCT FROM OLD.opportunity_id
     AND NEW.acquisition_id IS NOT DISTINCT FROM OLD.acquisition_id
     AND NEW.actor_type    IS NOT DISTINCT FROM OLD.actor_type
     AND NEW.occurred_at   IS NOT DISTINCT FROM OLD.occurred_at
     AND NEW.created_at    IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  IF operation IS NULL THEN
    -- Unreachable for application code while the RLS policy is the only UPDATE
    -- grant. Kept as a second, independent statement of the same rule: if the
    -- policy is ever loosened by mistake, this still refuses.
    RAISE EXCEPTION
      'The activity timeline is append-only (ADR-0014).'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW.workspace_id  IS DISTINCT FROM OLD.workspace_id
  OR NEW.type          IS DISTINCT FROM OLD.type
  OR NEW.occurred_at   IS DISTINCT FROM OLD.occurred_at
  OR NEW.created_at    IS DISTINCT FROM OLD.created_at
  OR NEW.actor_type    IS DISTINCT FROM OLD.actor_type
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
    -- Redaction only. Erasure must not move a timeline entry to another person
    -- while clearing it.
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
