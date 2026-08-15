-- =============================================================================
-- Password reset tokens
-- =============================================================================
-- WHY THIS TABLE HAS NO ROW-LEVEL SECURITY, DELIBERATELY
-- Every workspace-owned table in Growth OS is RLS-enabled and forced. This one
-- is not, for the same reason `users` and `sessions` are not: it is scoped to a
-- USER, not a workspace, and it is read by someone who is not authenticated and
-- whose workspaces are therefore unknown. There is no tenant scope to filter
-- by, so a policy on `app.workspace_id` would match nothing and break the flow
-- it is supposed to protect.
--
-- What protects it instead:
--   - the raw token is never stored, only SHA-256(HMAC(token, SESSION_SECRET))
--   - lookup is by that hash, so an attacker with database read access still
--     cannot construct a working link without the application secret
--   - 60-minute expiry and single use, claimed inside the consuming transaction
--   - the application never selects these rows by user id from a request path
--
-- Stated here rather than left to be noticed, because "a table without RLS" is
-- exactly the kind of thing a later audit should be able to find an answer for.
--
-- @see docs/decisions/ADR-0004-authentication.md
-- @see docs/security/authentication.md
-- =============================================================================

CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id","created_at");

COMMENT ON TABLE "password_reset_tokens" IS
  'Single-use password reset tokens, stored only as SHA-256(HMAC(token, SESSION_SECRET)). User-scoped, so deliberately not RLS-protected — see the migration header.';
