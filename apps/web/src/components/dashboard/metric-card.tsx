/**
 * Metric rendering.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The only component that renders a `MetricValue`, which makes it the single
 * enforcement point for Principle 3 ("never fabricate a number"):
 *
 *  - `provenance: 'fixture'` renders a visible DEMO badge.
 *  - `provenance: 'unavailable'` renders "Not connected" — never a zero. A
 *    missing measurement shown as 0 is the most common way analytics products
 *    mislead their users.
 *  - `provenance: 'estimate'` is labelled as an estimate.
 *
 * Because `MetricValue` cannot be constructed without declaring provenance,
 * and this is the only renderer, an unlabelled fabricated number cannot reach
 * the screen.
 *
 * @see docs/product/product-principles.md (Principle 3)
 */

import { Badge, Surface } from '@growth-os/ui';
import type { MetricValue, TrendPolarity } from '@growth-os/contracts';

/**
 * Is this movement good?
 *
 * Direction alone is not meaning: missed calls rising is bad, revenue rising
 * is good. Polarity is what turns a delta into a judgement, which is why it is
 * a required field on `MetricValue` rather than an optional decoration.
 */
function deltaTone(
  direction: 'up' | 'down' | 'flat',
  polarity: TrendPolarity,
): 'good' | 'bad' | 'neutral' {
  if (direction === 'flat' || polarity === 'neutral') return 'neutral';
  const isIncrease = direction === 'up';
  const increaseIsGood = polarity === 'higher_is_better';
  return isIncrease === increaseIsGood ? 'good' : 'bad';
}

const DELTA_CLASSES: Record<'good' | 'bad' | 'neutral', string> = {
  good: 'text-signal',
  bad: 'text-attention',
  neutral: 'text-text-subtle',
};

export function MetricCard({ metric }: { metric: MetricValue }) {
  const unavailable = metric.provenance === 'unavailable';

  return (
    <Surface level={1} className="flex flex-col gap-2.5 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-caption text-text-muted">{metric.label}</span>
        <ProvenanceBadge provenance={metric.provenance} />
      </div>

      <div className="flex items-baseline gap-2.5">
        <span
          className={[
            'font-mono text-metric tracking-tight tabular-nums',
            unavailable ? 'text-metric-sm text-text-subtle' : 'text-text',
          ].join(' ')}
        >
          {metric.formatted}
        </span>

        {metric.delta && !unavailable ? (
          <span
            className={`text-caption font-medium ${DELTA_CLASSES[deltaTone(metric.delta.direction, metric.polarity)]}`}
          >
            {metric.delta.direction === 'up' ? '+' : metric.delta.direction === 'down' ? '−' : ''}
            {Math.abs(metric.delta.percent)}%
            {/* The comparison window is announced but not shown, to keep the
                card dense while remaining unambiguous to assistive tech. */}
            <span className="sr-only"> {metric.delta.comparisonLabel}</span>
          </span>
        ) : null}
      </div>

      {metric.description ? (
        <p className="text-caption text-text-subtle">{metric.description}</p>
      ) : null}
    </Surface>
  );
}

/** Provenance marker. `live` renders nothing — the honest default needs no label. */
export function ProvenanceBadge({ provenance }: { provenance: MetricValue['provenance'] }) {
  if (provenance === 'live') return null;

  if (provenance === 'fixture') {
    return <Badge tone="fixture">Demo</Badge>;
  }

  if (provenance === 'estimate') {
    return <Badge tone="neutral">Estimate</Badge>;
  }

  return <Badge tone="neutral">Not connected</Badge>;
}

/** The single headline metric. One primary answer per screen. */
export function HeadlineMetric({ metric }: { metric: MetricValue }) {
  return (
    <Surface level={1} className="flex flex-col gap-3 p-6">
      <div className="flex items-center gap-2.5">
        <h2 className="text-caption text-text-muted">{metric.label}</h2>
        <ProvenanceBadge provenance={metric.provenance} />
      </div>

      <div className="flex items-baseline gap-3">
        <span className="font-mono text-metric-lg tracking-tight text-text tabular-nums">
          {metric.formatted}
        </span>
        {metric.unit === 'score' ? (
          <span className="font-mono text-metric-sm text-text-subtle">/ 100</span>
        ) : null}
        {metric.delta ? (
          <span
            className={`text-body font-medium ${DELTA_CLASSES[deltaTone(metric.delta.direction, metric.polarity)]}`}
          >
            {metric.delta.direction === 'up' ? '+' : '−'}
            {Math.abs(metric.delta.percent)}%
            <span className="sr-only"> {metric.delta.comparisonLabel}</span>
          </span>
        ) : null}
      </div>

      {metric.description ? (
        <p className="max-w-md text-caption text-text-subtle">{metric.description}</p>
      ) : null}
    </Surface>
  );
}
