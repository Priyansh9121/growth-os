'use client';

/**
 * Task list with filter views.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The operator's work queue. Filters map to the closed set declared in
 * `taskFiltersSchema` — never a free-form query (ADR-0016 §2).
 *
 * Completion is optimistic ONLY in the narrow, safe sense: the checkbox
 * disables and the row dims while the request is in flight, and the row's
 * final state comes from the server's response. It does not claim completion
 * before the database agrees.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Surface } from '@growth-os/ui';
import type { Page, TaskPriority, TaskView } from '@growth-os/contracts';

type ViewFilter = 'open' | 'today' | 'overdue' | 'completed';

const PRIORITY_TONE: Record<TaskPriority, 'critical' | 'attention' | 'neutral'> = {
  urgent: 'critical',
  high: 'attention',
  normal: 'neutral',
  low: 'neutral',
};

const VIEWS: readonly { id: ViewFilter; label: string; query: Record<string, string> }[] = [
  { id: 'open', label: 'Open', query: { status: 'open' } },
  { id: 'today', label: 'Due today', query: { status: 'open' } },
  { id: 'overdue', label: 'Overdue', query: { overdueOnly: 'true' } },
  { id: 'completed', label: 'Completed', query: { status: 'completed' } },
];

export function TasksList({
  initialPage,
  canWrite,
}: {
  initialPage: Page<TaskView>;
  canWrite: boolean;
}) {
  const [view, setView] = useState<ViewFilter>('open');
  const [tasks, setTasks] = useState<readonly TaskView[]>(initialPage.items);
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(nextView: ViewFilter, nextScope: 'all' | 'mine') {
    setLoading(true);
    setError(null);
    try {
      const config = VIEWS.find((candidate) => candidate.id === nextView);
      const params = new URLSearchParams({ ...config?.query, scope: nextScope, limit: '50' });

      const response = await fetch(`/api/crm/tasks?${params.toString()}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setError('Could not load tasks.');
        return;
      }
      const body = (await response.json()) as Page<TaskView>;

      // "Due today" is a client-side narrowing of the open set rather than a
      // server filter: a date boundary depends on the viewer's timezone, and
      // the server does not know it. Overdue IS server-side, because lateness
      // is absolute.
      const items =
        nextView === 'today'
          ? body.items.filter((task) => {
              if (!task.dueAt) return false;
              const due = new Date(task.dueAt);
              const now = new Date();
              return due.toDateString() === now.toDateString();
            })
          : body.items;

      setTasks(items);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }

  async function complete(task: TaskView) {
    if (!canWrite || busyId) return;
    setBusyId(task.id);
    try {
      const response = await fetch(`/api/crm/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status: 'completed' }),
      });
      if (!response.ok) {
        setError('Could not complete this task.');
        return;
      }
      const updated = (await response.json()) as TaskView;
      setTasks((existing) =>
        view === 'completed'
          ? existing.map((item) => (item.id === task.id ? updated : item))
          : existing.filter((item) => item.id !== task.id),
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Tab semantics so a screen reader announces which view is active. */}
        <div role="tablist" aria-label="Task views" className="flex flex-wrap gap-1">
          {VIEWS.map((candidate) => (
            <button
              key={candidate.id}
              role="tab"
              aria-selected={view === candidate.id}
              onClick={() => {
                setView(candidate.id);
                void load(candidate.id, scope);
              }}
              className={`rounded-md px-3 py-1.5 text-body transition-colors duration-[120ms] focus-visible:outline-none ${
                view === candidate.id
                  ? 'bg-surface-2 font-medium text-text'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              {candidate.label}
            </button>
          ))}
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const next = scope === 'all' ? 'mine' : 'all';
            setScope(next);
            void load(view, next);
          }}
        >
          {scope === 'all' ? 'All tasks' : 'My tasks'}
        </Button>
      </div>

      <p aria-live="polite" className="sr-only">
        {loading ? 'Loading tasks' : `${tasks.length} tasks shown`}
      </p>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {error}
        </p>
      ) : null}

      <Surface level={1} className="divide-y divide-line p-0">
        {tasks.map((task) => (
          <div
            key={task.id}
            className={`flex items-start gap-3 px-4 py-3 transition-opacity duration-[120ms] ${
              busyId === task.id ? 'opacity-50' : ''
            }`}
          >
            {canWrite && task.status === 'open' ? (
              <button
                type="button"
                onClick={() => void complete(task)}
                disabled={busyId !== null}
                aria-label={`Mark “${task.title}” complete`}
                className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-sm border border-line-strong transition-colors duration-[120ms] hover:border-signal focus-visible:outline-none disabled:opacity-40"
              >
                <span className="sr-only">Complete</span>
              </button>
            ) : (
              <span
                aria-hidden="true"
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-sm border ${
                  task.status === 'completed'
                    ? 'border-signal bg-signal-faint text-signal'
                    : 'border-line'
                }`}
              >
                {task.status === 'completed' ? '✓' : ''}
              </span>
            )}

            <div className="min-w-0 flex-1">
              <p
                className={`text-body ${
                  task.status === 'completed' ? 'text-text-subtle line-through' : 'text-text'
                }`}
              >
                {task.title}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                {task.contactId && task.contactName ? (
                  <Link
                    href={`/customers/contacts/${task.contactId}`}
                    className="text-caption text-text-muted hover:text-signal focus-visible:outline-none"
                  >
                    {task.contactName}
                  </Link>
                ) : null}
                {task.assignedName ? (
                  <span className="text-caption text-text-subtle">{task.assignedName}</span>
                ) : null}
                {/* `createdByType` distinguishes human work from AI- and
                    automation-created work. No AI creates tasks yet, but the
                    surface is ready (ADR-0011). */}
                {task.createdByType !== 'user' ? (
                  <Badge tone="neutral">{task.createdByType}</Badge>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {task.priority !== 'normal' ? (
                <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
              ) : null}
              {task.dueAt ? (
                <time
                  dateTime={task.dueAt}
                  className={`font-mono text-caption tabular-nums ${
                    task.isOverdue ? 'text-critical' : 'text-text-subtle'
                  }`}
                >
                  {new Date(task.dueAt).toLocaleDateString('en-AU', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </time>
              ) : null}
            </div>
          </div>
        ))}

        {tasks.length === 0 && !loading ? (
          <div className="px-6 py-14 text-center">
            <p className="text-h3 text-text">Nothing here</p>
            <p className="mt-1.5 text-body text-text-muted">
              {view === 'overdue' ? 'No overdue tasks — good.' : 'No tasks in this view.'}
            </p>
          </div>
        ) : null}
      </Surface>
    </div>
  );
}
