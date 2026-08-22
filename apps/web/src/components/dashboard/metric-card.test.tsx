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

/**
 * ⚠️ COLOUR IS NOT THE ONLY CARRIER OF THE JUDGEMENT.
 *
 * The tests above pin which numbers earn the accent. These pin something the
 * suite never asserted: that a reader who cannot resolve `--color-signal` from
 * `--color-attention` can still tell a good movement from a bad one.
 *
 * Under simulated red-green dichromacy the two tokens separate by 0.002 in
 * `growth-bright`, 0.003 in `growth-dark` and 0.008 in `growth-warm` — against
 * 0.067 in `light` and 0.085 in `dark`. Because the sign reports DIRECTION,
 * "Attributed revenue +18%" and "Missed calls +9%" both render `+`, so for a
 * protanope or a deuteranope the card carried no judgement at all. Neither did
 * it for a screen-reader user: the `sr-only` span announced the comparison
 * window and nothing else.
 *
 * @see docs/decisions/ADR-0062-status-colour-is-never-the-only-carrier.md
 */
describe('⚠️ the good/bad judgement survives with colour removed', () => {
  /** The delta element, found by its percentage rather than by its colour. */
  const deltaEl = (pattern: RegExp): HTMLElement[] =>
    screen.getAllByText(pattern).filter((element) => element.className.includes('font-medium'));

  it('⚠️ THE STRONG PROPERTY: same number, same direction, opposite polarity — the TEXT differs', () => {
    // The only test here that could not be satisfied by a decoration. Both
    // deltas are +9% up; the sole difference in the source data is polarity,
    // which used to reach the DOM exclusively as a colour class. If the carrier
    // is removed, both elements render the identical string and this fails.
    render(<MetricCard metric={metric({ polarity: 'higher_is_better', delta: up(9) })} />);
    render(<MetricCard metric={metric({ polarity: 'lower_is_better', delta: up(9) })} />);

    const [good, bad] = deltaEl(/9%/);
    expect(good, 'the good delta was not rendered').toBeDefined();
    expect(bad, 'the bad delta was not rendered').toBeDefined();
    expect(
      good!.textContent,
      'good and bad render the identical text — colour is the only carrier again',
    ).not.toEqual(bad!.textContent);
  });

  it('the good and the bad marks are different characters, not merely present', () => {
    // A carrier that rendered the same glyph for both would pass "a mark is
    // shown" and fail the reader, which is the failure mode this guards.
    render(<MetricCard metric={metric({ polarity: 'higher_is_better', delta: up(9) })} />);
    render(<MetricCard metric={metric({ polarity: 'lower_is_better', delta: up(9) })} />);

    const marks = deltaEl(/9%/).map(
      (element) => element.querySelector('[aria-hidden="true"]')?.textContent ?? '',
    );
    expect(marks[0], 'the good delta has no mark').toBeTruthy();
    expect(marks[1], 'the bad delta has no mark').toBeTruthy();
    expect(marks[0], 'both tones render the same mark').not.toEqual(marks[1]);
  });

  it('the mark is hidden from assistive tech, and the judgement is announced in words', () => {
    // The glyph and the phrase are two carriers for two audiences. Announcing
    // the glyph as well would read as "check mark a good result".
    render(<MetricCard metric={metric({ polarity: 'lower_is_better', delta: up(9) })} />);
    const [bad] = deltaEl(/9%/);
    expect(bad!.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(bad!.textContent).toContain('needs attention');
  });

  it('a good delta announces that it is good', () => {
    render(<MetricCard metric={metric({ delta: up(9) })} />);
    expect(deltaEl(/9%/)[0]!.textContent).toContain('a good result');
  });

  it('⚠️ a neutral movement claims NO judgement, in either channel', () => {
    // The negative that gives the two above their meaning. A metric with
    // neutral polarity has no judgement to make, and inventing one would be the
    // same failure as colouring a number for merely existing.
    render(<MetricCard metric={metric({ polarity: 'neutral', delta: up(9) })} />);
    const [neutral] = deltaEl(/9%/);
    expect(neutral!.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(neutral!.textContent).not.toContain('a good result');
    expect(neutral!.textContent).not.toContain('needs attention');
  });

  it('the comparison window is still announced alongside the judgement', () => {
    render(<MetricCard metric={metric({ polarity: 'lower_is_better', delta: up(9) })} />);
    expect(deltaEl(/9%/)[0]!.textContent).toContain('vs previous 30 days');
  });

  it('the headline metric carries the judgement too', () => {
    render(<HeadlineMetric metric={metric({ formatted: '82', unit: 'score', delta: up(4) })} />);
    const [delta] = deltaEl(/4%/);
    expect(delta!.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(delta!.textContent).toContain('a good result');
  });
});

/**
 * ⚠️ THE TWO CARDS HAD DRIFTED, AND SHARING ONE READOUT IS WHAT FIXED IT.
 *
 * `MetricCard` rendered no sign for a flat movement; `HeadlineMetric` rendered
 * `−`, a minus sign on a metric that had not moved. Two copies of the same
 * three-line expression, one of which had never handled the third case.
 */
describe('⚠️ a flat movement renders no sign, in BOTH cards', () => {
  const flat = { percent: 0, direction: 'flat', comparisonLabel: 'vs previous' } as const;

  it.each([
    ['MetricCard', (m: MetricValue) => <MetricCard metric={m} />],
    ['HeadlineMetric', (m: MetricValue) => <HeadlineMetric metric={m} />],
  ])('%s renders the flat delta with no sign in front of it', (_name, renderCard) => {
    render(renderCard(metric({ delta: flat })));
    const [delta] = screen
      .getAllByText(/0%/)
      .filter((element) => element.className.includes('font-medium'));
    expect(delta!.textContent!.trimStart()).toMatch(/^0%/);
  });
});
