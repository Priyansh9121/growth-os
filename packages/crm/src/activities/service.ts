/**
 * The activity timeline writer and reader.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The only path that writes to `activities`. Timeline entries are authored by
 * application services from what actually happened — never accepted from a
 * client, which could otherwise assert arbitrary history.
 *
 * ACTIVITY IS NOT AUDIT (ADR-0014)
 * `activities` answers *"what happened with this customer?"* — it is read by
 * every operator and deliberately contains PII. `audit_events` answers *"who
 * changed our data?"* — it is admin-only and deliberately contains none. One
 * user action commonly writes both, inside one transaction.
 *
 * `recordActivity` takes an explicit transaction because it is almost always
 * part of a larger atomic operation: an opportunity that moved stage without
 * its timeline entry, or vice versa, is exactly the inconsistency this design
 * prevents.
 *
 * @see docs/decisions/ADR-0014-activity-vs-audit.md
 */

import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  type ActivityType,
  type ActivityView,
  type ActorType,
  type Page,
} from '@growth-os/contracts';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import { displayName } from '../identity/normalise';
import { decodeCursor, sliceToPage } from '../shared/pagination';
import {
  actorUserId,
  contextNow,
  inTenant,
  requireCapability,
  tenantScope,
  workspaceId,
  type CrmContext,
} from '../shared/context';

const { activities, contacts, users } = schemaTables;

export interface RecordActivityInput {
  readonly type: ActivityType;
  readonly summary: string;
  readonly detail?: string | undefined;
  readonly contactId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly acquisitionId?: string | undefined;
  readonly actorType?: ActorType | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  /** When the business event occurred, if not now (e.g. an imported call). */
  readonly occurredAt?: Date | undefined;
}

/**
 * Append a timeline entry.
 *
 * Requires the caller's transaction so the activity commits or rolls back with
 * the change it describes. There is no fire-and-forget variant, deliberately.
 */
export async function recordActivity(
  context: CrmContext,
  tx: TenantTransaction,
  input: RecordActivityInput,
): Promise<string> {
  const [row] = await tx
    .insert(activities)
    .values({
      workspaceId: workspaceId(context),
      type: input.type,
      summary: input.summary,
      detail: input.detail ?? null,
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
      acquisitionId: input.acquisitionId ?? null,
      actorType: input.actorType ?? 'user',
      // A `system`- or `agent`-authored activity has no acting user.
      actorUserId: input.actorType && input.actorType !== 'user' ? null : actorUserId(context),
      metadata: input.metadata ?? null,
      occurredAt: input.occurredAt ?? contextNow(context),
    })
    .returning({ id: activities.id });

  if (!row) throw new Error('Failed to record activity');
  return row.id;
}

export interface ActivityFeedOptions {
  readonly contactId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * Read a timeline, newest first.
 *
 * Paginated by `(occurred_at, id)` — the same keyset approach as every other
 * list, so a busy timeline cannot return an unbounded response.
 */
export async function listActivities(
  context: CrmContext,
  options: ActivityFeedOptions,
): Promise<Page<ActivityView>> {
  requireCapability(context, 'workspace:crm:activities:read');

  const limit = Math.min(options.limit ?? 25, 100);
  const cursor = decodeCursor(options.cursor);

  return inTenant(context, async (tx, workspace) => {
    const conditions: SQL[] = [tenantScope(activities, workspace)];

    if (options.contactId) conditions.push(eq(activities.contactId, options.contactId));
    if (options.opportunityId) {
      conditions.push(eq(activities.opportunityId, options.opportunityId));
    }

    if (cursor) {
      const cursorDate = new Date(cursor.value);
      // Strictly-after in the sort direction, with id as the tiebreak, so a
      // row is never skipped or repeated when timestamps collide.
      const keyset = or(
        lt(activities.occurredAt, cursorDate),
        and(eq(activities.occurredAt, cursorDate), lt(activities.id, cursor.id)),
      );
      if (keyset) conditions.push(keyset);
    }

    const rows = await tx
      .select({
        id: activities.id,
        type: activities.type,
        summary: activities.summary,
        detail: activities.detail,
        actorType: activities.actorType,
        actorFirstName: users.name,
        contactId: activities.contactId,
        opportunityId: activities.opportunityId,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorUserId))
      .where(and(...conditions))
      .orderBy(desc(activities.occurredAt), desc(activities.id))
      // One extra row reveals whether a further page exists, without a
      // second COUNT query on every request.
      .limit(limit + 1);

    const page = sliceToPage(rows, limit, (row) => row.occurredAt.toISOString());

    return {
      items: page.items.map((row): ActivityView => ({
        id: row.id,
        type: row.type as ActivityType,
        summary: row.summary,
        detail: row.detail,
        actorType: row.actorType,
        actorName: row.actorFirstName,
        contactId: row.contactId,
        opportunityId: row.opportunityId,
        occurredAt: row.occurredAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  });
}

/**
 * Add a free-text note to the timeline.
 *
 * Notes do not get their own table: a separate mutable notes store would
 * duplicate the timeline and create two places to look for "what was said"
 * (ADR-0011 §4). A note is an activity whose body is user-authored.
 */
export async function addNote(
  context: CrmContext,
  input: { contactId?: string | undefined; opportunityId?: string | undefined; body: string },
): Promise<ActivityView> {
  requireCapability(context, 'workspace:crm:contacts:write');

  return inTenant(context, async (tx, workspace) => {
    // Verify the target belongs to this tenant before attaching anything to it.
    if (input.contactId) {
      const [target] = await tx
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), tenantScope(contacts, workspace)))
        .limit(1);
      if (!target) throw new Error('Contact not found in workspace');
    }

    const occurredAt = contextNow(context);
    const id = await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.NOTE_ADDED,
      summary: 'Note added',
      detail: input.body,
      contactId: input.contactId,
      opportunityId: input.opportunityId,
      occurredAt,
    });

    return {
      id,
      type: ACTIVITY_TYPES.NOTE_ADDED,
      summary: 'Note added',
      detail: input.body,
      actorType: 'user' as const,
      actorName: displayName(context.tenant.actor.name, null),
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
      occurredAt: occurredAt.toISOString(),
    };
  });
}
