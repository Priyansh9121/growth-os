/**
 * Custom field service — per-workspace contact fields.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Lets a plumbing business record "Property Type" and a dental practice record
 * "Patient Type" without either shape leaking into the other's schema, while
 * keeping every value ENUMERABLE — which is what erasure needs and what a
 * JSONB blob on `contacts` would have destroyed (ADR-0022).
 *
 * VALIDATION HAPPENS HERE, NOT AT THE DATABASE
 * The database enforces the structural rule (exactly one typed column is
 * populated). Whether a value fits its definition — a `single_select` value
 * being one of the declared options, a `number` actually parsing — is checked
 * here, because those rules change as a workspace edits its own fields and a
 * CHECK constraint cannot follow them.
 *
 * `required` is likewise enforced here and NOT as NOT NULL: a field made
 * required today must not retroactively invalidate contacts entered yesterday.
 *
 * THESE VALUES ARE THE LEAST PREDICTABLE PII IN THE SYSTEM
 * A workspace may create "Patient Type", "Case Number" or "Policy Number". No
 * AI tool returns them (ADR-0022), and erasure DELETES them rather than
 * replacing them with a placeholder, because there is no neutral placeholder
 * that is safe for an unknown field.
 *
 * @see docs/decisions/ADR-0022-custom-field-storage.md
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ConflictError,
  ValidationError,
  type CreateCustomFieldInput,
  type CustomFieldDefinitionView,
  type CustomFieldValueView,
  type SetCustomFieldValueInput,
  type UpdateCustomFieldInput,
} from '@growth-os/contracts';
import { AUDIT_EVENTS, schemaTables, writeAuditEvent } from '@growth-os/database';
import {
  actorUserId,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type CrmContext,
} from '../shared/context';

const { contactFieldDefinitions, contactFieldValues, contacts } = schemaTables;

type Tx = Parameters<Parameters<typeof inTenant>[1]>[0];
type DefinitionRow = typeof contactFieldDefinitions.$inferSelect;

/** A workspace cannot define an unbounded number of fields. */
const MAX_DEFINITIONS_PER_WORKSPACE = 40;

export async function listCustomFields(
  context: CrmContext,
  includeArchived = false,
): Promise<CustomFieldDefinitionView[]> {
  requireCapability(context, 'workspace:crm:contacts:read');

  return inTenant(context, async (tx, workspace) => {
    const rows = await definitionsFor(tx, workspace, includeArchived);
    return rows.map(projectDefinition);
  });
}

export async function createCustomField(
  context: CrmContext,
  input: CreateCustomFieldInput,
): Promise<CustomFieldDefinitionView> {
  requireCapability(context, 'workspace:crm:custom_fields:manage');

  return inTenant(context, async (tx, workspace) => {
    const [{ total = 0 } = {}] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(contactFieldDefinitions)
      .where(
        and(
          tenantScope(contactFieldDefinitions, workspace),
          isNull(contactFieldDefinitions.archivedAt),
        ),
      );

    if (total >= MAX_DEFINITIONS_PER_WORKSPACE) {
      throw new ConflictError(
        `Workspace ${workspace} has ${total} custom fields`,
        `A workspace can have up to ${MAX_DEFINITIONS_PER_WORKSPACE} custom fields. Archive one you no longer use.`,
      );
    }

    const [clash] = await tx
      .select({ id: contactFieldDefinitions.id })
      .from(contactFieldDefinitions)
      .where(
        and(
          tenantScope(contactFieldDefinitions, workspace),
          eq(contactFieldDefinitions.key, input.key),
        ),
      )
      .limit(1);

    if (clash) {
      // Including archived definitions: reusing an archived key would make its
      // surviving values reappear under a field that means something else.
      throw new ConflictError(
        `Custom field key ${input.key} is taken in workspace ${workspace}`,
        'A custom field with that key already exists. Keys cannot be reused, even after archiving.',
      );
    }

    const now = contextNow(context);
    const [row] = await tx
      .insert(contactFieldDefinitions)
      .values({
        workspaceId: workspace,
        key: input.key,
        label: input.label,
        type: input.type,
        required: input.required,
        options: input.options ?? null,
        position: total,
        createdByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) throw new Error('Failed to insert custom field definition');

    // Audited: defining a field is a change to the workspace's own schema, and
    // "who added the field that now holds patient data?" is a question a
    // workspace owner may genuinely need answered.
    await writeAuditEvent(
      context.deps.db,
      {
        workspaceId: workspace,
        actorUserId: actorUserId(context),
        eventName: AUDIT_EVENTS.CRM_CUSTOM_FIELD_DEFINED,
        accessPath: context.tenant.workspace.via,
        targetType: 'custom_field',
        targetId: row.id,
        correlationId: context.correlationId ?? undefined,
        metadata: { key: input.key, type: input.type },
      },
      tx,
    );

    return projectDefinition(row);
  });
}

export async function updateCustomField(
  context: CrmContext,
  definitionId: string,
  input: UpdateCustomFieldInput,
): Promise<CustomFieldDefinitionView> {
  requireCapability(context, 'workspace:crm:custom_fields:manage');

  return inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, contactFieldDefinitions, workspace, definitionId);
    const now = contextNow(context);

    const changes: Record<string, unknown> = { updatedAt: now };
    if (input.label !== undefined) changes['label'] = input.label;
    if (input.required !== undefined) changes['required'] = input.required;
    if (input.position !== undefined) changes['position'] = input.position;
    if (input.archived !== undefined) changes['archivedAt'] = input.archived ? now : null;

    if (input.options !== undefined) {
      if (existing.type !== 'single_select') {
        throw new ValidationError('Only a choice field can have options.');
      }

      // OPTIONS MAY BE ADDED, NEVER REMOVED.
      //
      // Removing an option would leave every contact holding it with a value
      // that is no longer valid — invisible in the UI, still present in the
      // database, and silently wrong in any export. Archiving the whole field
      // is the honest way to retire a set of choices.
      const current = existing.options ?? [];
      const missing = current.filter((option) => !input.options?.includes(option));
      if (missing.length > 0) {
        throw new ConflictError(
          `Options removed from ${definitionId}: ${missing.join(', ')}`,
          `Options cannot be removed once contacts may hold them (${missing.join(', ')}). Archive the field instead.`,
        );
      }
      changes['options'] = input.options;
    }

    await tx
      .update(contactFieldDefinitions)
      .set(changes)
      .where(
        and(
          eq(contactFieldDefinitions.id, definitionId),
          tenantScope(contactFieldDefinitions, workspace),
        ),
      );

    if (input.archived === true) {
      await writeAuditEvent(
        context.deps.db,
        {
          workspaceId: workspace,
          actorUserId: actorUserId(context),
          eventName: AUDIT_EVENTS.CRM_CUSTOM_FIELD_ARCHIVED,
          accessPath: context.tenant.workspace.via,
          targetType: 'custom_field',
          targetId: definitionId,
          correlationId: context.correlationId ?? undefined,
          metadata: { key: existing.key },
        },
        tx,
      );
    }

    const updated = await loadInTenant(tx, contactFieldDefinitions, workspace, definitionId);
    return projectDefinition(updated);
  });
}

/**
 * Set (or clear) one custom field value on a contact.
 *
 * Rides on `contacts:write` rather than a capability of its own: a custom field
 * value is ordinary contact data, and a separate capability would only invite
 * a workspace where someone can edit a contact's email but not their
 * "Property Type", which nobody wants and nobody would notice was wrong.
 */
export async function setCustomFieldValue(
  context: CrmContext,
  contactId: string,
  input: SetCustomFieldValueInput,
): Promise<readonly CustomFieldValueView[]> {
  requireCapability(context, 'workspace:crm:contacts:write');

  return inTenant(context, async (tx, workspace) => {
    await loadInTenant(tx, contacts, workspace, contactId, [
      isNull(contacts.deletedAt),
      isNull(contacts.mergedAt),
      // An erased contact must not accept new personal data. Without this,
      // erasure could be quietly undone one field at a time.
      isNull(contacts.erasedAt),
    ]);

    const definition = await loadInTenant(
      tx,
      contactFieldDefinitions,
      workspace,
      input.definitionId,
      [isNull(contactFieldDefinitions.archivedAt)],
    );

    const now = contextNow(context);

    if (input.value === null || input.value === '') {
      if (definition.required) {
        throw new ValidationError(`${definition.label} is required.`);
      }
      // DELETE rather than null every column: the `exactly one value` CHECK
      // makes an all-null row impossible, which is what stops "cleared" and
      // "never set" from becoming two indistinguishable states.
      await tx
        .delete(contactFieldValues)
        .where(
          and(
            tenantScope(contactFieldValues, workspace),
            eq(contactFieldValues.contactId, contactId),
            eq(contactFieldValues.definitionId, input.definitionId),
          ),
        );
      return valuesFor(tx, workspace, contactId);
    }

    const columns = coerceValue(definition, input.value);

    await tx
      .insert(contactFieldValues)
      .values({
        workspaceId: workspace,
        definitionId: input.definitionId,
        contactId,
        ...columns,
        updatedByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [contactFieldValues.definitionId, contactFieldValues.contactId],
        // Every typed column is written, not just the one in use: an upsert
        // that set only `value_number` would leave a stale `value_text` behind
        // and trip the exactly-one-value constraint.
        set: {
          valueText: columns.valueText,
          valueNumber: columns.valueNumber,
          valueBoolean: columns.valueBoolean,
          valueDate: columns.valueDate,
          updatedByUserId: actorUserId(context),
          updatedAt: now,
        },
      });

    // NOT recorded on the timeline. A custom field value is arbitrary
    // workspace-defined PII, and a timeline entry naming the field and its
    // value would copy it into the one surface every operator reads.
    return valuesFor(tx, workspace, contactId);
  });
}

export async function listCustomFieldValues(
  context: CrmContext,
  contactId: string,
): Promise<readonly CustomFieldValueView[]> {
  requireCapability(context, 'workspace:crm:contacts:read');
  return inTenant(context, (tx, workspace) => valuesFor(tx, workspace, contactId));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ValueColumns {
  valueText: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
  valueDate: string | null;
}

const EMPTY_COLUMNS: ValueColumns = {
  valueText: null,
  valueNumber: null,
  valueBoolean: null,
  valueDate: null,
};

/**
 * Map an API value onto the typed column its definition demands.
 *
 * Rejects rather than coerces on mismatch. Accepting `"probably 40ish"` into a
 * number field by silently storing it as text is precisely the failure a
 * typed schema exists to prevent, and it only surfaces later as a broken
 * report nobody can explain.
 */
function coerceValue(definition: DefinitionRow, value: string | number | boolean): ValueColumns {
  switch (definition.type) {
    case 'text': {
      if (typeof value !== 'string') {
        throw new ValidationError(`${definition.label} must be text.`);
      }
      return { ...EMPTY_COLUMNS, valueText: value.slice(0, 2000) };
    }

    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) {
        throw new ValidationError(`${definition.label} must be a number.`);
      }
      return { ...EMPTY_COLUMNS, valueNumber: parsed };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { ...EMPTY_COLUMNS, valueBoolean: value };
      if (value === 'true' || value === 'false') {
        return { ...EMPTY_COLUMNS, valueBoolean: value === 'true' };
      }
      throw new ValidationError(`${definition.label} must be yes or no.`);
    }

    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new ValidationError(`${definition.label} must be a date (YYYY-MM-DD).`);
      }
      // Round-tripped through Date so 2026-02-30 is rejected rather than
      // silently rolled forward to 2 March by PostgreSQL's parser.
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
        throw new ValidationError(`${definition.label} is not a real date.`);
      }
      return { ...EMPTY_COLUMNS, valueDate: value };
    }

    case 'single_select': {
      if (typeof value !== 'string' || !(definition.options ?? []).includes(value)) {
        throw new ValidationError(
          `${definition.label} must be one of: ${(definition.options ?? []).join(', ')}.`,
        );
      }
      return { ...EMPTY_COLUMNS, valueText: value };
    }
  }
}

function readValue(
  definition: Pick<DefinitionRow, 'type'>,
  row: typeof contactFieldValues.$inferSelect,
): string | number | boolean | null {
  switch (definition.type) {
    case 'number':
      return row.valueNumber;
    case 'boolean':
      return row.valueBoolean;
    case 'date':
      return row.valueDate;
    case 'text':
    case 'single_select':
      return row.valueText;
  }
}

async function definitionsFor(
  tx: Tx,
  workspace: string,
  includeArchived: boolean,
): Promise<DefinitionRow[]> {
  const conditions = [tenantScope(contactFieldDefinitions, workspace)];
  if (!includeArchived) conditions.push(isNull(contactFieldDefinitions.archivedAt));

  return tx
    .select()
    .from(contactFieldDefinitions)
    .where(and(...conditions))
    .orderBy(asc(contactFieldDefinitions.position), asc(contactFieldDefinitions.label));
}

async function valuesFor(
  tx: Tx,
  workspace: string,
  contactId: string,
): Promise<CustomFieldValueView[]> {
  const definitions = await definitionsFor(tx, workspace, false);
  if (definitions.length === 0) return [];

  const rows = await tx
    .select()
    .from(contactFieldValues)
    .where(
      and(
        tenantScope(contactFieldValues, workspace),
        eq(contactFieldValues.contactId, contactId),
        inArray(
          contactFieldValues.definitionId,
          definitions.map((definition) => definition.id),
        ),
      ),
    );

  const byDefinition = new Map(rows.map((row) => [row.definitionId, row]));

  // Every live definition is returned, valued or not, so the detail page can
  // render the full form without a second round trip to discover what is
  // missing.
  return definitions.map((definition) => {
    const row = byDefinition.get(definition.id);
    return {
      definitionId: definition.id,
      key: definition.key,
      label: definition.label,
      type: definition.type,
      value: row ? readValue(definition, row) : null,
    };
  });
}

function projectDefinition(row: DefinitionRow): CustomFieldDefinitionView {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: row.options ?? null,
    position: row.position,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
