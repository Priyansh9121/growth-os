/**
 * Resolving a public form key to a tenant.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The ONE privileged read in the public path, and the boundary between "an
 * anonymous request arrived" and "we know which workspace this belongs to".
 *
 * WHY THIS NEEDS A PRIVILEGED FUNCTION AT ALL
 * `forms` is RLS-protected on `app.workspace_id`, and an anonymous request has
 * no workspace scope — so an ordinary query returns zero rows. The isolation
 * layer that protects everything else is precisely what blocks the lookup that
 * would establish the scope.
 *
 * `resolve_public_form` (migration 0007) is the answer: one text input, a fixed
 * narrow output, pinned `search_path`, no dynamic SQL, and no reach past the
 * form and its published version. RLS is disabled nowhere.
 *
 * @see docs/decisions/ADR-0026-public-form-resolution.md
 */

import { sql } from 'drizzle-orm';
import {
  formVersionConfigSchema,
  type FormFieldConfig,
  type FormSettingsConfig,
  type FormStatus,
  type PublicFormView,
} from '@growth-os/contracts';
import { withUnscopedTransaction, type Database } from '@growth-os/database';
import { honeypotKeyFor } from './honeypot';

/**
 * A resolved form. **Internal** — never serialised to a browser.
 *
 * Carries the workspace id and the CRM field mapping, which is exactly what a
 * public response must not contain. `toPublicView` produces the browser's
 * projection separately, so adding a field here cannot accidentally publish it.
 */
export interface ResolvedForm {
  readonly formId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: FormStatus;
  readonly versionId: string;
  readonly version: number;
  readonly fields: readonly FormFieldConfig[];
  readonly settings: FormSettingsConfig;
}

interface ResolveRow extends Record<string, unknown> {
  readonly form_id: string;
  readonly workspace_id: string;
  readonly form_name: string;
  readonly form_status: FormStatus;
  readonly version_id: string;
  readonly version_number: number;
  readonly fields: unknown;
  readonly settings: unknown;
}

/**
 * Resolve a public key.
 *
 * Returns `null` for unknown, unpublished and archived alike — the caller
 * cannot tell them apart, which is what stops a key from being probed for
 * existence.
 *
 * A key that resolves to a `draft` or `inactive` form DOES return a value here,
 * because the submission path needs to record a receipt against the right form
 * before refusing it. The refusal, and the identical public message, happen one
 * layer up.
 */
export async function resolvePublicForm(
  db: Database,
  publicKey: string,
): Promise<ResolvedForm | null> {
  // Bounded before it reaches the database. The column is 32 hex characters
  // and the CHECK constraint enforces that, so anything else cannot match —
  // rejecting it here avoids a query per malformed probe.
  if (!/^[0-9a-f]{32}$/.test(publicKey)) return null;

  // Unscoped by NECESSITY, not convenience: the caller has no tenant context,
  // and this lookup is what establishes one. Named conspicuously so its use is
  // obvious in review, exactly as `withUnscopedTransaction` is meant to be.
  const rows = await withUnscopedTransaction(db, async (tx) =>
    tx.execute<ResolveRow>(sql`select * from resolve_public_form(${publicKey})`),
  );

  const row = rows[0];
  if (!row) return null;

  // Parsed on READ as well as on write. A version row written by an older
  // build must still validate, or the public form fails closed rather than
  // rendering a configuration it does not understand.
  const parsed = formVersionConfigSchema.safeParse({
    fields: row.fields,
    settings: row.settings,
  });
  if (!parsed.success) return null;

  return {
    formId: row.form_id,
    workspaceId: row.workspace_id,
    name: row.form_name,
    status: row.form_status,
    versionId: row.version_id,
    version: row.version_number,
    fields: parsed.data.fields,
    settings: parsed.data.settings,
  };
}

/**
 * Project a resolved form into what a browser may know.
 *
 * ⚠️ AN ALLOW-LIST, BUILT FIELD BY FIELD — not the internal shape with a few
 * keys deleted. Adding a property to `ResolvedForm` therefore cannot silently
 * publish it; someone has to add it here on purpose.
 *
 * Notably absent: `workspaceId`, `formId`, `versionId`, every field's `target`
 * (which would tell a caller which input becomes the email address), the
 * opportunity rule, the pipeline, the allowed origins, and the abuse settings.
 */
export function toPublicView(form: ResolvedForm, publicKey: string): PublicFormView {
  return {
    publicKey,
    name: form.name,
    fields: form.fields.map((field) => ({
      key: field.key,
      type: field.type,
      label: field.label,
      placeholder: field.placeholder ?? null,
      helpText: field.helpText ?? null,
      required: field.required,
      options: field.options ?? null,
      maxLength: field.maxLength,
    })),
    submitLabel: form.settings.submitLabel,
    theme: form.settings.theme,
    accent: form.settings.accent ?? null,
    honeypotEnabled: form.settings.honeypotEnabled,
    honeypotKey: form.settings.honeypotEnabled ? honeypotKeyFor(form.versionId) : null,
  };
}
