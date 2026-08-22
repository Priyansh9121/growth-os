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

/**
 * ⚠️ THE JUDGEMENT NOW HAS A CARRIER THAT IS NOT COLOUR.
 *
 * `text-signal` against `text-attention` used to be the ONLY thing separating
 * "+18%" on Attributed revenue from "+9%" on Missed calls. The sign reports
 * DIRECTION, and direction is not judgement — both of those render `+`, so the
 * good result and the bad one differed by nothing but hue.
 *
 * Measured under simulated red-green dichromacy, the two tokens separate by
 * **0.002** in `growth-bright`, **0.003** in `growth-dark` and **0.008** in
 * `growth-warm`, against 0.067 and 0.085 in the two themes that survive. For a
 * protanope or a deuteranope the two deltas were the same colour, so the card
 * reported nothing.
 *
 * ⚠️ AND THE SAME ELEMENT ANNOUNCED NOTHING EITHER. The `sr-only` span carried
 * the comparison window and not the judgement, so a screen-reader user with
 * ordinary colour vision was in exactly the same position. One carrier closes
 * both gaps.
 *
 * The colour stays. It is redundant now rather than load-bearing, which is what
 * `accessibility.md`'s review checklist has asked for since Stage 1 and nothing
 * enforced.
 *
 * @see docs/decisions/ADR-0062-status-colour-is-never-the-only-carrier.md
 */
const DELTA_MARK: Record<'good' | 'bad' | 'neutral', string> = {
  good: '✓',
  bad: '!',
  neutral: '',
};

/** What assistive technology hears. Empty where there is no judgement to make. */
const DELTA_JUDGEMENT: Record<'good' | 'bad' | 'neutral', string> = {
  good: 'a good result',
  bad: 'needs attention',
  neutral: '',
};

/** `+`/`−` reports DIRECTION only. A flat movement has no sign to report. */
const DIRECTION_SIGN: Record<'up' | 'down' | 'flat', string> = {
  up: '+',
  down: '−',
  flat: '',
};

/**
 * The delta readout, rendered once for both cards.
 *
 * ⚠️ EXTRACTED RATHER THAN DUPLICATED, AND THE TWO COPIES HAD ALREADY DRIFTED.
 * `MetricCard` handled `flat` and `HeadlineMetric` did not — it rendered `−`
 * for a flat movement, a minus sign on a metric that had not moved. Sharing one
 * readout fixes that, and a test pins it, rather than leaving two copies to
 * drift again.
 */
function DeltaReadout({
  delta,
  polarity,
  sizeClass,
}: {
  delta: NonNullable<MetricValue['delta']>;
  polarity: TrendPolarity;
  sizeClass: string;
}) {
  const tone = deltaTone(delta.direction, polarity);
  const mark = DELTA_MARK[tone];
  const judgement = DELTA_JUDGEMENT[tone];

  return (
    <span className={`${sizeClass} font-medium ${DELTA_CLASSES[tone]}`}>
      {mark ? (
        // Hidden from the accessibility tree because the phrase below says the
        // same thing in words. A glyph read aloud as "check mark" is noise.
        <span aria-hidden="true" className="mr-0.5">
          {mark}
        </span>
      ) : null}
      {DIRECTION_SIGN[delta.direction]}
      {Math.abs(delta.percent)}%
      {/* Judgement and comparison window are announced but not shown: the card
          stays dense, and nothing about it is ambiguous to assistive tech. */}
      <span className="sr-only">
        {judgement ? `, ${judgement}` : ''} {delta.comparisonLabel}
      </span>
    </span>
  );
}

/**
 * The left accent stripe.
 *
 * ⚠️ IT IS A TOKEN, NOT A THEME CHECK. `--color-card-accent` is `transparent`
 * in the base theme and the accent colour in the three Growth themes, so this
 * one class is a visible stripe under Growth and nothing at all under Dark and
 * Light — with no `theme === '…'` branch in any component (ADR-0058).
 *
 * `border-l-2` is applied unconditionally so the card's box model is identical
 * in every theme: a stripe that changed the layout would move the content when
 * someone switched theme.
 */
const CARD_ACCENT = 'border-l-2 border-l-card-accent';

/**
 * Does this value earn the accent?
 *
 * ⚠️ ONLY A MEASURED, GENUINELY-GOOD MOVEMENT. A metric with no delta —
 * "New contacts: 8" — has no direction and therefore no judgement to render, so
 * it stays text-coloured. Colouring it would mark a number for merely existing,
 * which is exactly the failure the ~5% discipline names: if everything is
 * highlighted, nothing is.
 *
 * `unavailable` is excluded because "Not connected" is not a good result.
 */
function valueEarnsAccent(metric: MetricValue): boolean {
  if (metric.provenance === 'unavailable' || !metric.delta) return false;
  return deltaTone(metric.delta.direction, metric.polarity) === 'good';
}

/** Emphasis colour when earned; the ordinary text colour otherwise. */
const valueClass = (metric: MetricValue): string =>
  valueEarnsAccent(metric) ? 'text-metric-emphasis' : 'text-text';

export function MetricCard({ metric }: { metric: MetricValue }) {
  const unavailable = metric.provenance === 'unavailable';

  return (
    <Surface level={1} className={`flex flex-col gap-2.5 p-4 ${CARD_ACCENT}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-caption text-text-muted">{metric.label}</span>
        <ProvenanceBadge provenance={metric.provenance} />
      </div>

      <div className="flex items-baseline gap-2.5">
        <span
          className={[
            'font-mono text-metric tracking-tight tabular-nums',
            unavailable ? 'text-metric-sm text-text-subtle' : valueClass(metric),
          ].join(' ')}
        >
          {metric.formatted}
        </span>

        {metric.delta && !unavailable ? (
          <DeltaReadout delta={metric.delta} polarity={metric.polarity} sizeClass="text-caption" />
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
    <Surface level={1} className={`flex flex-col gap-3 p-6 ${CARD_ACCENT}`}>
      <div className="flex items-center gap-2.5">
        <h2 className="text-caption text-text-muted">{metric.label}</h2>
        <ProvenanceBadge provenance={metric.provenance} />
      </div>

      <div className="flex items-baseline gap-3">
        <span
          className={`font-mono text-metric-lg tracking-tight tabular-nums ${valueClass(metric)}`}
        >
          {metric.formatted}
        </span>
        {metric.unit === 'score' ? (
          <span className="font-mono text-metric-sm text-text-subtle">/ 100</span>
        ) : null}
        {metric.delta ? (
          <DeltaReadout delta={metric.delta} polarity={metric.polarity} sizeClass="text-body" />
        ) : null}
      </div>

      {metric.description ? (
        <p className="max-w-md text-caption text-text-subtle">{metric.description}</p>
      ) : null}
    </Surface>
  );
}
