/**
 * Contact erasure — the privacy path.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Makes [ADR-0013](docs/decisions/ADR-0013-soft-deletion-and-retention.md)'s
 * statement true: soft delete is not erasure, and erasure had to exist before
 * the first real customer. This is that.
 *
 * ANONYMISE IN PLACE; DO NOT CASCADE-DELETE
 * Deleting the contact would cascade to acquisitions, opportunities, tasks and
 * activities, destroying revenue and channel history. That history is a
 * business fact about the workspace, not personal data about the individual,
 * and a business is entitled — often required — to keep it.
 *
 * So the commercial shape survives and only the *who* is removed. After an
 * erasure, "12 leads from organic search, 3 became customers, $14k" still
 * answers correctly; "who was the third one?" does not.
 *
 * WHAT THIS DOES NOT DO
 * It clears the LIVE database. It does not reach into backups, and this file
 * does not pretend otherwise. `erasure_requests` records every erasure
 * permanently and PII-free, precisely so the set can be replayed if a backup
 * is ever restored (ADR-0020 §6, docs/security/data-lifecycle.md).
 *
 * @see docs/decisions/ADR-0020-privacy-erasure.md
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  ConflictError,
  type ErasurePreview,
  type ErasureResult,
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

type Tx = Parameters<Parameters<typeof inTenant>[1]>[0];

/**
 * What survives an erasure, shown in the UI beside what does not.
 *
 * Stated explicitly because the most common misunderstanding of "erase this
 * customer" is that it deletes the sale. It does not, and an operator who
 * believes it does will avoid using the feature they are obliged to use.
 */
const RETAINED_AFTER_ERASURE: readonly string[] = [
  'Deal values, stages and win/loss outcomes',
  'Which channel each enquiry came from, and when',
  'Campaign attribution (source, medium, campaign)',
  'The shape of the timeline — what happened and when, without the wording',
];

export async function previewErasure(
  context: CrmContext,
  contactId: string,
): Promise<ErasurePreview> {
  requireCapability(context, 'workspace:crm:contacts:erase');

  return inTenant(context, async (tx, workspace) => {
    const contact = await loadInTenant(tx, contacts, workspace, contactId);

    const blockers: string[] = [];
    if (contact.erasedAt !== null) {
      blockers.push('This contact has already been erased.');
    }
    if (contact.mergedAt !== null) {
      // Erasing a tombstone would clear a redirect's identity while leaving
      // the survivor — the record that actually holds the person's data —
      // fully intact. The operator must erase the survivor instead.
      blockers.push(
        'This record was merged into another contact. Erase the surviving contact instead.',
      );
    }

    return {
      contactId,
      displayName: displayName(contact.firstName, contact.lastName),
      clears: await countAffected(tx, workspace, contactId),
      retained: RETAINED_AFTER_ERASURE,
      blockers,
    };
  });
}

export async function eraseContact(context: CrmContext, contactId: string): Promise<ErasureResult> {
  requireCapability(context, 'workspace:crm:contacts:erase');

  const now = contextNow(context);
  const actor = actorUserId(context);

  const result = await inTenant(context, async (tx, workspace) => {
    const contact = await loadInTenant(tx, contacts, workspace, contactId);

    if (contact.erasedAt !== null) {
      throw new ConflictError(
        `Contact ${contactId} is already erased`,
        'This contact has already been erased.',
      );
    }
    if (contact.mergedAt !== null) {
      throw new ConflictError(
        `Contact ${contactId} is a merge tombstone`,
        'This record was merged into another contact. Erase the surviving contact instead.',
      );
    }

    // The timeline entry is written BEFORE the erasure, so it is itself
    // redacted by the same operation. An entry saying "Sarah Nguyen was
    // erased" would be a copy of the thing just erased, sitting in the one
    // place an operator is guaranteed to look.
    await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.CONTACT_ERASED,
      summary: 'Personal details erased at request',
      contactId,
      occurredAt: now,
    });

    const cleared = await callEraseFunction(tx, workspace, contactId, actor);

    // In-transaction for the same reason as merge: an irreversible change to
    // customer data that committed without its audit record would leave no
    // trace, and there is no later chance to notice.
    //
    // The record deliberately carries COUNTS ONLY. An audit trail that
    // preserved the erased name would defeat the erasure (ADR-0020 §5).
    await writeAuditEvent(
      context.deps.db,
      {
        workspaceId: workspace,
        actorUserId: actor,
        eventName: AUDIT_EVENTS.CRM_CONTACT_ERASED,
        accessPath: context.tenant.workspace.via,
        targetType: 'contact',
        targetId: contactId,
        correlationId: context.correlationId ?? undefined,
        metadata: { cleared },
      },
      tx,
    );

    return { contactId, erasedAt: now.toISOString(), cleared };
  });

  context.deps.events.publish({
    name: 'crm.contact.erased',
    workspaceId: context.tenant.workspace.workspaceId,
    occurredAt: now.toISOString(),
    correlationId: context.correlationId,
    actorType: 'user',
    actorUserId: actor,
    contactId: result.contactId,
    clearedActivities: result.cleared.activities,
  });

  return result;
}

async function callEraseFunction(
  tx: Tx,
  workspace: string,
  contactId: string,
  actor: string,
): Promise<ErasureResult['cleared']> {
  const rows = await tx.execute<{ counts: ErasureResult['cleared'] }>(
    sql`select crm_erase_contact(${workspace}::uuid, ${contactId}::uuid, ${actor}::uuid) as counts`,
  );

  const counts = rows[0]?.counts;
  if (!counts) throw new Error('crm_erase_contact returned no result');
  return counts;
}

/**
 * Count what erasure will touch.
 *
 * ⚠️ THE REACH HERE MUST MATCH `crm_erase_contact` EXACTLY.
 *
 * Tasks and activities are reachable through the contact's OPPORTUNITIES as
 * well as directly: `tasks.contact_id` and `tasks.opportunity_id` are
 * independently nullable, so a task raised against a deal has no `contact_id`
 * at all while its title still reads "Call Sarah about the hot water quote".
 * A preview that counted only the direct links would under-report, and an
 * erasure that cleared only them would leave PII behind while reporting
 * success.
 */
async function countAffected(
  tx: Tx,
  workspace: string,
  contactId: string,
): Promise<ErasurePreview['clears']> {
  const dealIds = sql`(select id from ${opportunities}
                        where workspace_id = ${workspace} and contact_id = ${contactId})`;
  const acquisitionIds = sql`(select id from ${acquisitions}
                        where workspace_id = ${workspace} and contact_id = ${contactId})`;

  const [row] = await tx
    .select({
      acquisitions: sql<number>`(
        select count(*)::int from ${acquisitions}
         where workspace_id = ${workspace} and contact_id = ${contactId})`,
      opportunities: sql<number>`(
        select count(*)::int from ${opportunities}
         where workspace_id = ${workspace} and contact_id = ${contactId})`,
      tasks: sql<number>`(
        select count(*)::int from ${tasks}
         where workspace_id = ${workspace}
           and (contact_id = ${contactId} or opportunity_id in ${dealIds}))`,
      activities: sql<number>`(
        select count(*)::int from ${activities}
         where workspace_id = ${workspace}
           and (contact_id = ${contactId}
                or opportunity_id in ${dealIds}
                or acquisition_id in ${acquisitionIds}))`,
      customFields: sql<number>`(
        select count(*)::int from ${contactFieldValues}
         where workspace_id = ${workspace} and contact_id = ${contactId})`,
      tags: sql<number>`(
        select count(*)::int from ${contactTags}
         where workspace_id = ${workspace} and contact_id = ${contactId})`,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), tenantScope(contacts, workspace)))
    .limit(1);

  return (
    row ?? {
      acquisitions: 0,
      opportunities: 0,
      tasks: 0,
      activities: 0,
      customFields: 0,
      tags: 0,
    }
  );
}

/**
 * Every erasure this workspace has performed.
 *
 * Read-gated on `contacts:erase` rather than `audit:read`: the list is the
 * workspace's own compliance record, and the operator responsible for
 * erasures is the one who needs to produce it. It contains no PII — ids,
 * counts and timestamps only.
 */
export async function listErasures(
  context: CrmContext,
  limit = 50,
): Promise<
  readonly {
    contactId: string;
    completedAt: string;
    affectedCounts: Record<string, number>;
  }[]
> {
  requireCapability(context, 'workspace:crm:contacts:erase');

  const { erasureRequests } = schemaTables;

  return inTenant(context, async (tx, workspace) => {
    const rows = await tx
      .select({
        contactId: erasureRequests.contactId,
        completedAt: erasureRequests.completedAt,
        affectedCounts: erasureRequests.affectedCounts,
      })
      .from(erasureRequests)
      .where(tenantScope(erasureRequests, workspace))
      .orderBy(sql`${erasureRequests.completedAt} desc`)
      .limit(Math.min(limit, 200));

    return rows.map((row) => ({
      contactId: row.contactId,
      completedAt: row.completedAt.toISOString(),
      affectedCounts: row.affectedCounts,
    }));
  });
}

/**
 * Verification helper: does any trace of this text remain in the CRM?
 *
 * Exists so the integration suite can assert erasure by SEARCHING for the old
 * name, email and phone rather than by checking the columns the erasure
 * routine happens to touch. A test written against the implementation would
 * pass even if the implementation missed a column; this one cannot.
 *
 * Not exposed through any route — it takes a raw search term and scans free
 * text across the workspace, which is a shape no API should offer.
 */
export async function countTracesOf(context: CrmContext, term: string): Promise<number> {
  requireCapability(context, 'workspace:crm:contacts:erase');

  const pattern = `%${term.replace(/[%_]/g, (match) => `\\${match}`)}%`;

  return inTenant(context, async (tx, workspace) => {
    const [row] = await tx.execute<{ traces: number }>(sql`
      select (
        (select count(*) from ${contacts}
          where workspace_id = ${workspace}
            and (first_name ilike ${pattern} or coalesce(last_name,'') ilike ${pattern}
              or coalesce(email,'') ilike ${pattern} or coalesce(phone,'') ilike ${pattern}))
      + (select count(*) from ${tasks}
          where workspace_id = ${workspace}
            and (title ilike ${pattern} or coalesce(description,'') ilike ${pattern}))
      + (select count(*) from ${opportunities}
          where workspace_id = ${workspace} and title ilike ${pattern})
      + (select count(*) from ${activities}
          where workspace_id = ${workspace}
            and (summary ilike ${pattern} or coalesce(detail,'') ilike ${pattern}
              or coalesce(metadata::text,'') ilike ${pattern}))
      + (select count(*) from ${acquisitions}
          where workspace_id = ${workspace}
            and (coalesce(channel_detail,'') ilike ${pattern}
              or coalesce(metadata::text,'') ilike ${pattern}))
      + (select count(*) from ${contactFieldValues}
          where workspace_id = ${workspace} and coalesce(value_text,'') ilike ${pattern})
      )::int as traces
    `);

    return row?.traces ?? 0;
  });
}

/** Live contacts only — merged and erased rows are excluded everywhere. */
export function liveContactConditions() {
  return [isNull(contacts.deletedAt), isNull(contacts.mergedAt)];
}
