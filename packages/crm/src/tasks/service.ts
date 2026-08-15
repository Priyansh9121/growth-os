/**
 * Task service.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Work assigned to a human — and, from Stage 7, to an AI agent or an
 * automation. `createdByType` exists from day one for exactly that reason:
 * retrofitting an actor type onto a populated table means guessing at history.
 *
 * ⚠️ Stage 2 gives AI **no autonomous execution capability**. An agent may
 * eventually create a task (a proposal a human reviews), but nothing here
 * lets a model complete work on its own. `createdByType` is representational,
 * not permission-granting.
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 * @see docs/architecture/ai-agent-architecture.md
 */

import { and, asc, eq, gt, isNull, isNotNull, lt, lte, or, type SQL } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  NotFoundError,
  ValidationError,
  type ActorType,
  type CreateTaskInput,
  type Page,
  type TaskPriority,
  type TaskStatus,
  type TaskFilters,
  type TaskView,
  type UpdateTaskInput,
} from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import { displayName } from '../identity/normalise';
import { decodeCursor, sliceToPage } from '../shared/pagination';
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

const { contacts, opportunities, tasks, users } = schemaTables;

export async function createTask(
  context: CrmContext,
  input: CreateTaskInput,
  options: { createdByType?: ActorType } = {},
): Promise<TaskView> {
  requireCapability(context, 'workspace:crm:tasks:write');

  return inTenant(context, async (tx, workspace) => {
    // Both relations are verified tenant-scoped, so a task cannot be linked to
    // another workspace's contact or deal.
    if (input.contactId) {
      await loadInTenant(tx, contacts, workspace, input.contactId, [isNull(contacts.deletedAt)]);
    }
    if (input.opportunityId) {
      await loadInTenant(tx, opportunities, workspace, input.opportunityId);
    }

    const now = contextNow(context);
    const [row] = await tx
      .insert(tasks)
      .values({
        workspaceId: workspace,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        assignedUserId: input.assignedUserId ?? actorUserId(context),
        contactId: input.contactId ?? null,
        opportunityId: input.opportunityId ?? null,
        createdByType: options.createdByType ?? 'user',
        createdByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    if (!row) throw new Error('Failed to insert task');

    // Only surface a task on the customer timeline when it relates to one —
    // an unrelated internal task is not part of a customer's history.
    if (input.contactId || input.opportunityId) {
      await recordActivity(context, tx, {
        type: ACTIVITY_TYPES.TASK_CREATED,
        summary: `Task created — ${input.title}`,
        contactId: input.contactId,
        opportunityId: input.opportunityId,
        actorType: options.createdByType ?? 'user',
        occurredAt: now,
      });
    }

    context.deps.events.publish({
      name: 'crm.task.created',
      workspaceId: workspace,
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      actorType: options.createdByType ?? 'user',
      actorUserId: actorUserId(context),
      taskId: row.id,
      assignedUserId: input.assignedUserId ?? actorUserId(context),
      priority: input.priority,
      dueAt: input.dueAt ?? null,
    });

    return projectTask(tx, workspace, row.id, now);
  });
}

export async function completeTask(context: CrmContext, taskId: string): Promise<TaskView> {
  requireCapability(context, 'workspace:crm:tasks:write');

  return inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, tasks, workspace, taskId);
    const now = contextNow(context);

    // Idempotent: completing an already-complete task is a no-op, not an error.
    // Double-submits and retries are normal.
    if (existing.status === 'completed') return projectTask(tx, workspace, taskId, now);

    if (existing.status === 'cancelled') {
      throw new ValidationError('A cancelled task cannot be completed.');
    }

    await tx
      .update(tasks)
      .set({
        status: 'completed',
        completedAt: now,
        completedByUserId: actorUserId(context),
        updatedAt: now,
      })
      .where(and(eq(tasks.id, taskId), tenantScope(tasks, workspace)));

    if (existing.contactId || existing.opportunityId) {
      await recordActivity(context, tx, {
        type: ACTIVITY_TYPES.TASK_COMPLETED,
        summary: `Task completed — ${existing.title}`,
        contactId: existing.contactId ?? undefined,
        opportunityId: existing.opportunityId ?? undefined,
        occurredAt: now,
      });
    }

    context.deps.events.publish({
      name: 'crm.task.completed',
      workspaceId: workspace,
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      actorType: 'user',
      actorUserId: actorUserId(context),
      taskId,
    });

    return projectTask(tx, workspace, taskId, now);
  });
}

export async function updateTask(
  context: CrmContext,
  taskId: string,
  input: UpdateTaskInput,
): Promise<TaskView> {
  requireCapability(context, 'workspace:crm:tasks:write');

  return inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, tasks, workspace, taskId);
    const now = contextNow(context);

    const changes: Record<string, unknown> = { updatedAt: now };
    if (input.title !== undefined) changes['title'] = input.title;
    if (input.description !== undefined) changes['description'] = input.description;
    if (input.priority !== undefined) changes['priority'] = input.priority;
    if (input.dueAt !== undefined) changes['dueAt'] = input.dueAt ? new Date(input.dueAt) : null;
    if (input.assignedUserId !== undefined) changes['assignedUserId'] = input.assignedUserId;

    if (input.status !== undefined && input.status !== existing.status) {
      changes['status'] = input.status;
      if (input.status === 'completed') {
        changes['completedAt'] = now;
        changes['completedByUserId'] = actorUserId(context);
      }
      // Cancelling rather than deleting: abandoning work is an outcome that
      // belongs in history (ADR-0013).
      if (input.status === 'cancelled' && (existing.contactId || existing.opportunityId)) {
        await recordActivity(context, tx, {
          type: ACTIVITY_TYPES.TASK_CANCELLED,
          summary: `Task cancelled — ${existing.title}`,
          contactId: existing.contactId ?? undefined,
          opportunityId: existing.opportunityId ?? undefined,
          occurredAt: now,
        });
      }
    }

    await tx
      .update(tasks)
      .set(changes)
      .where(and(eq(tasks.id, taskId), tenantScope(tasks, workspace)));

    return projectTask(tx, workspace, taskId, now);
  });
}

export async function listTasks(
  context: CrmContext,
  filters: TaskFilters,
): Promise<Page<TaskView>> {
  requireCapability(context, 'workspace:crm:tasks:read');

  const cursor = decodeCursor(filters.cursor);

  return inTenant(context, async (tx, workspace) => {
    const now = contextNow(context);
    const conditions: SQL[] = [tenantScope(tasks, workspace)];

    if (filters.scope === 'mine') {
      conditions.push(eq(tasks.assignedUserId, actorUserId(context)));
    }
    if (filters.status) conditions.push(eq(tasks.status, filters.status));
    if (filters.priority) conditions.push(eq(tasks.priority, filters.priority));
    if (filters.dueBefore) conditions.push(lte(tasks.dueAt, new Date(filters.dueBefore)));

    if (filters.overdueOnly) {
      // Overdue is derived server-side from the server clock, so a client with
      // a skewed clock cannot change what counts as late.
      conditions.push(eq(tasks.status, 'open'));
      conditions.push(isNotNull(tasks.dueAt));
      conditions.push(lt(tasks.dueAt, now));
    }

    if (cursor) {
      // Sorted by due date ascending — soonest first is what an operator wants.
      const value = cursor.value === '' ? null : new Date(cursor.value);
      if (value) {
        const keyset = or(
          gt(tasks.dueAt, value),
          and(eq(tasks.dueAt, value), gt(tasks.id, cursor.id)),
        );
        if (keyset) conditions.push(keyset);
      }
    }

    const rows = await tx
      .select(taskSelection())
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assignedUserId))
      .leftJoin(contacts, eq(contacts.id, tasks.contactId))
      .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
      .where(and(...conditions))
      // NULLS LAST: undated tasks belong at the bottom, not the top.
      .orderBy(asc(tasks.dueAt), asc(tasks.id))
      .limit(filters.limit + 1);

    const page = sliceToPage(rows, filters.limit, (row) => row.dueAt?.toISOString() ?? '');

    return {
      items: page.items.map((row) => toTaskView(row, now)),
      nextCursor: page.nextCursor,
    };
  });
}

function taskSelection() {
  return {
    id: tasks.id,
    title: tasks.title,
    description: tasks.description,
    status: tasks.status,
    priority: tasks.priority,
    dueAt: tasks.dueAt,
    assignedUserId: tasks.assignedUserId,
    assignedName: users.name,
    contactId: tasks.contactId,
    contactFirstName: contacts.firstName,
    contactLastName: contacts.lastName,
    opportunityId: tasks.opportunityId,
    opportunityTitle: opportunities.title,
    createdByType: tasks.createdByType,
    createdAt: tasks.createdAt,
    completedAt: tasks.completedAt,
  };
}

/** The row shape produced by `taskSelection()`, derived rather than restated. */
type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: Date | null;
  assignedUserId: string | null;
  assignedName: string | null;
  contactId: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  opportunityId: string | null;
  opportunityTitle: string | null;
  createdByType: ActorType;
  createdAt: Date;
  completedAt: Date | null;
};

function toTaskView(row: TaskRow, now: Date): TaskView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt?.toISOString() ?? null,
    assignedUserId: row.assignedUserId,
    assignedName: row.assignedName,
    contactId: row.contactId,
    contactName: row.contactFirstName
      ? displayName(row.contactFirstName, row.contactLastName)
      : null,
    opportunityId: row.opportunityId,
    opportunityTitle: row.opportunityTitle,
    createdByType: row.createdByType,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    isOverdue: row.status === 'open' && row.dueAt !== null && row.dueAt < now,
  };
}

async function projectTask(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  taskId: string,
  now: Date,
): Promise<TaskView> {
  const [row] = await tx
    .select(taskSelection())
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedUserId))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
    .where(and(eq(tasks.id, taskId), tenantScope(tasks, workspace)))
    .limit(1);

  if (!row) throw new NotFoundError(`Task ${taskId} not found`);
  return toTaskView(row, now);
}
