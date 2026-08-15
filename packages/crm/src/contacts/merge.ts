/**
 * Contact merge — preview and execute.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Resolves the duplicates that [ADR-0015](docs/decisions/ADR-0015-contact-identity-and-deduplication.md)
 * deliberately only *reports*. Automatic merging was rejected there and is
 * still rejected: shared mailboxes (`office@`, `info@`) are common in the
 * target segment, and folding two real people together is not reversible.
 *
 * THERE IS NO UNMERGE, AND THIS FILE DOES NOT PRETEND OTHERWISE
 * A true unmerge would need per-row provenance of which contact originally
 * owned each record, plus a reversal of every field decision a human made by
 * hand. A half-working undo on customer data is worse than none, because it
 * invites the destructive action it cannot actually reverse (ADR-0019 §1).
 *
 * What exists instead: a preview that computes the exact blast radius with no
 * mutation, an explicit `confirm`, a tombstone rather than a deletion, and an
 * audit record written inside the same transaction.
 *
 * WHY THE ROW RE-HOMING HAPPENS IN SQL
 * `activities` has no UPDATE policy — that absence is what makes the timeline
 * append-only — and `acquisitions` has a trigger freezing `contact_id`. The
 * `crm_merge_contacts` function in migration 0004 is the single sanctioned
 * escalation past both. Conflict resolution stays here in TypeScript, where it
 * is unit-testable; the function does only mechanical re-pointing.
 *
 * @see docs/decisions/ADR-0019-contact-merge.md
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  ConflictError,
  MERGEABLE_FIELD_LABELS,
  MERGEABLE_FIELDS,
  ValidationError,
  type MergeableField,
  type MergeContactsInput,
  type MergeFieldConflict,
  type MergeFieldFill,
  type MergePreview,
  type MergeResult,
} from '@growth-os/contracts';
import { AUDIT_EVENTS, schemaTables, writeAuditEvent } from '@growth-os/database';
import { displayName } from '../identity/normalise';
import {
  actorUserId,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type CrmContext,
} from '../shared/context';
import { recordActivity } from '../activities/service';

const {
  acquisitions,
  activities,
  contactFieldValues,
  contactTags,
  contacts,
  opportunities,
  tasks,
} = schemaTables;

type ContactRow = typeof contacts.$inferSelect;
type Tx = Parameters<Parameters<typeof inTenant>[1]>[0];

/** Move counts returned by `crm_merge_contacts`, keyed as the function names them. */
interface MoveCounts {
  readonly acquisitions: number;
  readonly opportunities: number;
  readonly tasks: number;
  readonly activities: number;
  readonly tags: number;
  readonly customFields: number;
}

const NO_MOVES: MoveCounts = {
  acquisitions: 0,
  opportunities: 0,
  tasks: 0,
  activities: 0,
  tags: 0,
  customFields: 0,
};

/**
 * Compute what a merge would do. Mutates nothing.
 *
 * Requires the merge capability rather than plain read: the preview reveals
 * both contacts' conflicting field values side by side, which is more than a
 * `viewer` sees on either record alone.
 */
export async function previewMerge(
  context: CrmContext,
  survivorId: string,
  duplicateId: string,
): Promise<MergePreview> {
  requireCapability(context, 'workspace:crm:contacts:merge');

  if (survivorId === duplicateId) {
    throw new ValidationError('A contact cannot be merged into itself.');
  }

  return inTenant(context, async (tx, workspace) => {
    const survivor = await loadInTenant(tx, contacts, workspace, survivorId);
    // The duplicate is loaded WITHOUT the `deleted_at IS NULL` filter: merging
    // an already-archived duplicate into a live contact is a normal cleanup,
    // and refusing it would leave archived duplicates unresolvable forever.
    const duplicate = await loadInTenant(tx, contacts, workspace, duplicateId);

    const blockers = mergeBlockers(survivor, duplicate);
    const { conflicts, fills } = compareFields(survivor, duplicate);

    return {
      survivor: party(survivor),
      duplicate: party(duplicate),
      moves: blockers.length > 0 ? NO_MOVES : await countMoves(tx, workspace, duplicateId),
      conflicts,
      fills,
      blockers,
    };
  });
}

export async function mergeContacts(
  context: CrmContext,
  input: MergeContactsInput,
): Promise<MergeResult> {
  requireCapability(context, 'workspace:crm:contacts:merge');

  if (input.survivorId === input.duplicateId) {
    throw new ValidationError('A contact cannot be merged into itself.');
  }

  const now = contextNow(context);
  const actor = actorUserId(context);

  const result = await inTenant(context, async (tx, workspace) => {
    const survivor = await loadInTenant(tx, contacts, workspace, input.survivorId);
    const duplicate = await loadInTenant(tx, contacts, workspace, input.duplicateId);

    // Checked here as well as inside the SQL function. The function's messages
    // are correct but terse; these are the ones an operator reads.
    const blockers = mergeBlockers(survivor, duplicate);
    if (blockers.length > 0) {
      throw new ConflictError(
        `Merge ${input.duplicateId} → ${input.survivorId} blocked: ${blockers.join('; ')}`,
        blockers[0] ?? 'These contacts cannot be merged.',
      );
    }

    // Re-home every owned row and mark the tombstone. One call, one
    // transaction — a contact whose deals moved but whose timeline did not is
    // precisely the half-state this shape prevents.
    const moved = await callMergeFunction(
      tx,
      workspace,
      input.survivorId,
      input.duplicateId,
      actor,
    );

    const changes = resolveFields(survivor, duplicate, input.fieldChoices);
    if (Object.keys(changes).length > 0) {
      await tx
        .update(contacts)
        .set({ ...changes, updatedAt: now })
        .where(and(eq(contacts.id, input.survivorId), tenantScope(contacts, workspace)));
    }

    await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.CONTACT_MERGED,
      summary: `Merged a duplicate record into ${displayName(survivor.firstName, survivor.lastName)}`,
      contactId: input.survivorId,
      occurredAt: now,
      // Counts and field NAMES only. The duplicate's values are the very thing
      // being consolidated; echoing them into the timeline would spread them.
      metadata: {
        mergedContactId: input.duplicateId,
        moved,
        fieldsChanged: Object.keys(changes),
      },
    });

    // Written INSIDE the transaction, unlike the rest of the CRM where the
    // route writes it afterwards. A merge that committed without its audit
    // record would be an irreversible change to customer data with no trace,
    // and there is no later opportunity to notice.
    await writeAuditEvent(
      context.deps.db,
      {
        workspaceId: workspace,
        actorUserId: actor,
        eventName: AUDIT_EVENTS.CRM_CONTACT_MERGED,
        accessPath: context.tenant.workspace.via,
        targetType: 'contact',
        targetId: input.survivorId,
        correlationId: context.correlationId ?? undefined,
        metadata: { mergedContactId: input.duplicateId, moved },
      },
      tx,
    );

    return { survivorId: input.survivorId, mergedContactId: input.duplicateId, moved };
  });

  context.deps.events.publish({
    name: 'crm.contact.merged',
    workspaceId: context.tenant.workspace.workspaceId,
    occurredAt: now.toISOString(),
    correlationId: context.correlationId,
    actorType: 'user',
    actorUserId: actor,
    survivorId: result.survivorId,
    mergedContactId: result.mergedContactId,
    movedOpportunities: result.moved.opportunities,
  });

  return result;
}

/**
 * Resolve a contact id that may be a merge tombstone.
 *
 * Returns the redirect target when the id points at a merged contact, so the
 * API can answer `{ mergedInto }` rather than a 404. Returns `null` for a
 * normal contact — the caller then proceeds as usual.
 */
export async function resolveMergeRedirect(
  context: CrmContext,
  contactId: string,
): Promise<{ mergedInto: string; mergedAt: string } | null> {
  requireCapability(context, 'workspace:crm:contacts:read');

  return inTenant(context, async (tx, workspace) => {
    const [row] = await tx
      .select({ mergedInto: contacts.mergedIntoContactId, mergedAt: contacts.mergedAt })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), tenantScope(contacts, workspace)))
      .limit(1);

    if (!row?.mergedInto || !row.mergedAt) return null;
    return { mergedInto: row.mergedInto, mergedAt: row.mergedAt.toISOString() };
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function callMergeFunction(
  tx: Tx,
  workspace: string,
  survivorId: string,
  duplicateId: string,
  actor: string,
): Promise<MoveCounts> {
  const rows = await tx.execute<{ counts: MoveCounts }>(
    sql`select crm_merge_contacts(
          ${workspace}::uuid, ${survivorId}::uuid, ${duplicateId}::uuid, ${actor}::uuid
        ) as counts`,
  );

  // Defensive: a function that returned nothing would otherwise surface as
  // "merged 0 rows" rather than as the failure it is.
  const counts = rows[0]?.counts;
  if (!counts) throw new Error('crm_merge_contacts returned no result');
  return counts;
}

/**
 * Reasons a merge must not proceed.
 *
 * Returned as a list rather than thrown one at a time so the preview can show
 * every problem at once instead of revealing them one refresh apart.
 */
function mergeBlockers(survivor: ContactRow, duplicate: ContactRow): string[] {
  const blockers: string[] = [];

  if (survivor.mergedAt !== null) {
    blockers.push('The surviving contact has already been merged into another record.');
  }
  if (duplicate.mergedAt !== null) {
    blockers.push('The duplicate has already been merged into another record.');
  }
  if (survivor.erasedAt !== null || duplicate.erasedAt !== null) {
    // Merging into or out of an erased contact would resurrect identity that
    // someone asked to have removed.
    blockers.push('An erased contact cannot take part in a merge.');
  }
  if (survivor.deletedAt !== null) {
    blockers.push('The surviving contact is archived. Restore it before merging.');
  }

  return blockers;
}

function party(row: ContactRow): MergePreview['survivor'] {
  return {
    id: row.id,
    displayName: displayName(row.firstName, row.lastName),
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The mergeable columns, read from a row without a per-field switch. */
function fieldValue(row: ContactRow, field: MergeableField): string | null {
  switch (field) {
    case 'firstName':
      return row.firstName;
    case 'lastName':
      return row.lastName;
    case 'email':
      return row.email;
    case 'phone':
      return row.phone;
    case 'companyId':
      return row.companyId;
    case 'ownerUserId':
      return row.ownerUserId;
  }
}

/**
 * Split the field differences into decisions and free gains.
 *
 * A `fill` — survivor NULL, duplicate populated — is taken automatically
 * because keeping it is a strict gain with no information loss. A `conflict`
 * needs a human, and the survivor wins by default.
 */
function compareFields(
  survivor: ContactRow,
  duplicate: ContactRow,
): { conflicts: MergeFieldConflict[]; fills: MergeFieldFill[] } {
  const conflicts: MergeFieldConflict[] = [];
  const fills: MergeFieldFill[] = [];

  for (const field of MERGEABLE_FIELDS) {
    const mine = fieldValue(survivor, field);
    const theirs = fieldValue(duplicate, field);

    if (theirs === null || theirs === '') continue;

    if (mine === null || mine === '') {
      fills.push({ field, label: MERGEABLE_FIELD_LABELS[field], value: theirs });
    } else if (mine !== theirs) {
      conflicts.push({
        field,
        label: MERGEABLE_FIELD_LABELS[field],
        survivorValue: mine,
        duplicateValue: theirs,
      });
    }
  }

  return { conflicts, fills };
}

/**
 * The survivor's final field values.
 *
 * VALUES ARE NEVER CONCATENATED. `sarah@a.test; sarah@b.test` is not an email
 * address, and a CRM that stores one has quietly broken every send, match and
 * export that touches it. Multi-value support is a separate feature, not
 * something to fake here (ADR-0019 §5).
 *
 * `firstName` is special-cased as non-nullable: the column is NOT NULL, and an
 * override that cleared it would fail at the database rather than at the API.
 */
function resolveFields(
  survivor: ContactRow,
  duplicate: ContactRow,
  choices: MergeContactsInput['fieldChoices'],
): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  const { conflicts, fills } = compareFields(survivor, duplicate);

  for (const fill of fills) {
    changes[fill.field] = fill.value;
  }

  for (const conflict of conflicts) {
    if (choices?.[conflict.field] === 'duplicate') {
      changes[conflict.field] = conflict.duplicateValue;
    }
  }

  // Identity columns carry derived matching keys. Writing `email` without
  // rewriting `email_normalised` would make the survivor unfindable by the
  // very address just merged onto them (ADR-0015).
  if (typeof changes['email'] === 'string') {
    changes['emailNormalised'] = changes['email'].trim().toLowerCase();
  }
  if (typeof changes['phone'] === 'string') {
    // The E.164 key comes from the duplicate's already-normalised column
    // rather than being re-parsed: it was normalised with this workspace's
    // region at write time, and re-deriving it here could silently differ.
    changes['phoneE164'] = duplicate.phoneE164;
  }

  return changes;
}

async function countMoves(tx: Tx, workspace: string, duplicateId: string): Promise<MoveCounts> {
  const [row] = await tx
    .select({
      acquisitions: sql<number>`(
        select count(*)::int from ${acquisitions}
         where workspace_id = ${workspace} and contact_id = ${duplicateId})`,
      opportunities: sql<number>`(
        select count(*)::int from ${opportunities}
         where workspace_id = ${workspace} and contact_id = ${duplicateId})`,
      tasks: sql<number>`(
        select count(*)::int from ${tasks}
         where workspace_id = ${workspace} and contact_id = ${duplicateId})`,
      activities: sql<number>`(
        select count(*)::int from ${activities}
         where workspace_id = ${workspace} and contact_id = ${duplicateId})`,
      tags: sql<number>`(
        select count(*)::int from ${contactTags}
         where workspace_id = ${workspace} and contact_id = ${duplicateId})`,
      customFields: sql<number>`(
        select count(*)::int from ${contactFieldValues}
         where workspace_id = ${workspace} and contact_id = ${duplicateId})`,
    })
    .from(contacts)
    .where(and(eq(contacts.id, duplicateId), tenantScope(contacts, workspace)))
    .limit(1);

  return row ?? NO_MOVES;
}

/**
 * Duplicate candidates for one contact, for the merge picker.
 *
 * Exact normalised email or phone only — the same rule
 * `findDuplicateCandidate` uses at create time. Fuzzy name matching is
 * deliberately absent: two "James Carter"s are two people, and a suggestion
 * list that implies otherwise is how a wrong merge gets made confidently.
 */
export async function findMergeCandidates(
  context: CrmContext,
  contactId: string,
): Promise<MergePreview['duplicate'][]> {
  requireCapability(context, 'workspace:crm:contacts:merge');

  return inTenant(context, async (tx, workspace) => {
    const subject = await loadInTenant(tx, contacts, workspace, contactId);

    if (subject.emailNormalised === null && subject.phoneE164 === null) return [];

    const rows = await tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(
        and(
          tenantScope(contacts, workspace),
          isNull(contacts.deletedAt),
          isNull(contacts.mergedAt),
          isNull(contacts.erasedAt),
          sql`${contacts.id} <> ${contactId}`,
          sql`(
            (${subject.emailNormalised}::text is not null
              and ${contacts.emailNormalised} = ${subject.emailNormalised})
            or (${subject.phoneE164}::text is not null
              and ${contacts.phoneE164} = ${subject.phoneE164})
          )`,
        ),
      )
      .limit(10);

    return rows.map((row) => ({
      id: row.id,
      displayName: displayName(row.firstName, row.lastName),
      email: row.email,
      phone: row.phone,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}
