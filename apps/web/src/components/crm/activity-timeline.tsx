/**
 * Contact activity timeline.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Renders the business history of a customer — the surface that becomes
 * Growth OS's most valuable as calls, appointments and revenue land in later
 * stages.
 *
 * This is the CRM ACTIVITY feed, not the audit trail. It deliberately contains
 * PII and is readable by every operator; the audit trail contains identifiers
 * only and is admin-gated (ADR-0014).
 *
 * Rendered as an ordered list so assistive technology conveys sequence, with
 * `<time datetime>` so dates are machine-readable.
 */

import type { ActivityType, ActivityView } from '@growth-os/contracts';
import { Surface } from '@growth-os/ui';

/**
 * Timeline dot colour by event class.
 *
 * Deliberately restrained: only genuinely terminal commercial outcomes get an
 * accent. If every row were coloured, the colour would carry no information.
 */
const TYPE_ACCENT: Partial<Record<ActivityType, string>> = {
  'opportunity.won': 'bg-signal',
  'opportunity.lost': 'bg-critical',
  'acquisition.recorded': 'bg-signal-dim',
  'acquisition.qualified': 'bg-signal-dim',
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const minutesAgo = Math.floor((Date.now() - date.getTime()) / 60_000);

  if (minutesAgo < 1) return 'just now';
  if (minutesAgo < 60) return `${minutesAgo}m ago`;
  if (minutesAgo < 1440) return `${Math.floor(minutesAgo / 60)}h ago`;
  if (minutesAgo < 10_080) return `${Math.floor(minutesAgo / 1440)}d ago`;
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ActivityTimeline({ activities }: { activities: readonly ActivityView[] }) {
  if (activities.length === 0) {
    return (
      <Surface level={1} className="p-8 text-center">
        <p className="text-body text-text-muted">No activity yet.</p>
        <p className="mt-1 text-caption text-text-subtle">
          Everything that happens with this contact appears here.
        </p>
      </Surface>
    );
  }

  return (
    <ol className="flex flex-col">
      {activities.map((activity, index) => {
        const isLast = index === activities.length - 1;

        return (
          <li key={activity.id} className="flex gap-3">
            {/* Connector rail. Decorative — the list semantics carry order. */}
            <div className="flex flex-col items-center" aria-hidden="true">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  TYPE_ACCENT[activity.type] ?? 'bg-line-strong'
                }`}
              />
              {!isLast ? <span className="w-px flex-1 bg-line" /> : null}
            </div>

            <div className={`min-w-0 flex-1 ${isLast ? 'pb-0' : 'pb-5'}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="text-body text-text">{activity.summary}</p>
                <time
                  dateTime={activity.occurredAt}
                  title={new Date(activity.occurredAt).toLocaleString('en-AU')}
                  className="shrink-0 font-mono text-caption text-text-subtle tabular-nums"
                >
                  {formatWhen(activity.occurredAt)}
                </time>
              </div>

              {activity.detail ? (
                <p className="mt-1 text-caption whitespace-pre-wrap text-text-muted">
                  {activity.detail}
                </p>
              ) : null}

              {/* Actor is shown only when it is NOT an ordinary user action —
                  "Sam did this" is noise; "the AI did this" is not. */}
              {activity.actorType !== 'user' ? (
                <p className="mt-1 text-overline text-text-subtle uppercase">
                  {activity.actorType}
                </p>
              ) : activity.actorName ? (
                <p className="mt-1 text-caption text-text-subtle">{activity.actorName}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
