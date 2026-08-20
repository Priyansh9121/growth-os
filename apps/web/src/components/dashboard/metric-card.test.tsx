/**
 * Which numbers earn the accent.
 *
 * WHAT THIS PROTECTS
 * ADR-0058 spends more accent on the dashboard, and the whole value of that
 * depends on it staying *selective*. A number is emphasised only when a
 * measured movement was genuinely good — never for merely existing, and never
 * when the movement was bad. If everything is highlighted, nothing is.
 *
 * ⚠️ POLARITY, NOT SIGN. "Missed calls up 9%" is an increase and a bad result.
 * Reading the sign off the number would emphasise it. These tests pin the
 * distinction, because it is the one a future refactor is most likely to lose.
 *
 * @see docs/decisions/ADR-0058-dashboard-accent-emphasis.md
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MetricValue } from '@growth-os/contracts';
import { HeadlineMetric, MetricCard } from './metric-card';

const base: MetricValue = {
  key: 'test',
  label: 'Tracked calls',
  value: 36,
  formatted: '36',
  unit: 'count',
  provenance: 'live',
  polarity: 'higher_is_better',
};

const metric = (over: Partial<MetricValue>): MetricValue => ({ ...base, ...over });
const up = (percent = 12) =>
  ({ percent, direction: 'up', comparisonLabel: 'vs previous 30 days' }) as const;
const down = (percent = 12) =>
  ({ percent, direction: 'down', comparisonLabel: 'vs previous 30 days' }) as const;

/**
 * The rendered element carrying the metric's own number.
 *
 * Scoped to the mono-spaced value, not matched by text: an `unavailable` metric
 * renders "Not connected" BOTH as its value and as its provenance badge, so a
 * plain text query finds two elements and throws.
 */
const valueEl = (formatted: string): HTMLElement => {
  const found = screen
    .getAllByText(formatted)
    .find((element) => element.className.includes('font-mono'));
  if (!found) throw new Error(`No mono-spaced value element showing "${formatted}"`);
  return found;
};

describe('a metric value earns the accent only for a good measured movement', () => {
  it('⚠️ a rise in a higher-is-better metric IS emphasised', () => {
    render(<MetricCard metric={metric({ delta: up() })} />);
    expect(valueEl('36')).toHaveClass('text-metric-emphasis');
  });

  it('⚠️ a rise in a LOWER-is-better metric is NOT emphasised', () => {
    // Missed calls going up is an increase and a bad result. This is the case
    // that a sign-based implementation gets wrong.
    render(
      <MetricCard
        metric={metric({ label: 'Missed calls', polarity: 'lower_is_better', delta: up(9) })}
      />,
    );
    expect(valueEl('36')).not.toHaveClass('text-metric-emphasis');
    expect(valueEl('36')).toHaveClass('text-text');
  });

  it('a FALL in a lower-is-better metric IS emphasised', () => {
    render(<MetricCard metric={metric({ polarity: 'lower_is_better', delta: down(9) })} />);
    expect(valueEl('36')).toHaveClass('text-metric-emphasis');
  });

  it('a fall in a higher-is-better metric is NOT emphasised', () => {
    render(<MetricCard metric={metric({ delta: down() })} />);
    expect(valueEl('36')).not.toHaveClass('text-metric-emphasis');
  });

  it('⚠️ a metric with NO delta is NOT emphasised', () => {
    // "New contacts: 8" has no direction, so there is no judgement to render.
    // Five of the dashboard's live CRM metrics are in exactly this state.
    render(<MetricCard metric={metric({ label: 'New contacts', formatted: '8' })} />);
    expect(valueEl('8')).not.toHaveClass('text-metric-emphasis');
    expect(valueEl('8')).toHaveClass('text-text');
  });

  it('a neutral-polarity metric is NOT emphasised, whichever way it moved', () => {
    render(<MetricCard metric={metric({ polarity: 'neutral', delta: up() })} />);
    expect(valueEl('36')).not.toHaveClass('text-metric-emphasis');
  });

  it('a flat delta is NOT emphasised', () => {
    render(
      <MetricCard
        metric={metric({
          delta: { percent: 0, direction: 'flat', comparisonLabel: 'vs previous' },
        })}
      />,
    );
    expect(valueEl('36')).not.toHaveClass('text-metric-emphasis');
  });

  it('⚠️ an unavailable metric is never emphasised', () => {
    // "Not connected" is not a good result, and the value is not a measurement.
    render(
      <MetricCard
        metric={metric({ provenance: 'unavailable', value: null, formatted: 'Not connected' })}
      />,
    );
    expect(valueEl('Not connected')).not.toHaveClass('text-metric-emphasis');
  });

  it('the headline metric follows the same rule', () => {
    render(<HeadlineMetric metric={metric({ formatted: '82', unit: 'score', delta: up(4) })} />);
    expect(valueEl('82')).toHaveClass('text-metric-emphasis');
  });

  it('the headline metric is not emphasised without a delta', () => {
    render(<HeadlineMetric metric={metric({ formatted: '82', unit: 'score' })} />);
    expect(valueEl('82')).not.toHaveClass('text-metric-emphasis');
  });
});

describe('the accent stripe', () => {
  it('⚠️ is on EVERY card, not only emphasised ones', () => {
    // The stripe is structure, not a judgement — it marks "this is a stat card".
    // Only its COLOUR is theme-dependent, and in Dark and Light it resolves to
    // transparent, so the box model is identical in all five themes.
    const { container } = render(<MetricCard metric={metric({ formatted: '8' })} />);
    expect(container.querySelector('.border-l-card-accent')).not.toBeNull();
  });

  it('is on a card whose movement was bad', () => {
    const { container } = render(
      <MetricCard metric={metric({ polarity: 'lower_is_better', delta: up(9) })} />,
    );
    expect(container.querySelector('.border-l-card-accent')).not.toBeNull();
  });

  it('is on the headline metric too', () => {
    const { container } = render(<HeadlineMetric metric={metric({ formatted: '82' })} />);
    expect(container.querySelector('.border-l-card-accent')).not.toBeNull();
  });
});

describe('the delta itself keeps its existing tones', () => {
  it('a good delta stays signal-coloured', () => {
    render(<MetricCard metric={metric({ delta: up() })} />);
    expect(screen.getByText(/12%/)).toHaveClass('text-signal');
  });

  it('a bad delta stays attention-coloured, not accent', () => {
    render(<MetricCard metric={metric({ polarity: 'lower_is_better', delta: up(9) })} />);
    expect(screen.getByText(/9%/)).toHaveClass('text-attention');
  });
});
