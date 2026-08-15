'use client';

/**
 * Ranked growth opportunities.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Renders `GrowthOpportunity` values and — critically — their evidence.
 *
 * PRINCIPLE 4 IS ENFORCED BY STRUCTURE, NOT BY CONVENTION
 * "Every recommendation carries its evidence." Each item exposes a
 * `<details>` element containing the signals it was derived from and their
 * sources. The evidence is always present in the markup (so it is findable,
 * printable and readable by assistive technology), just collapsed by default
 * to keep the list scannable.
 *
 * A recommendation with no visible basis is a horoscope. This component is
 * what stops one shipping.
 *
 * @see docs/product/product-principles.md (Principle 4)
 */

import { Badge, Surface } from '@growth-os/ui';
import type { GrowthOpportunity, OpportunityPriority } from '@growth-os/contracts';
import { GROWTH_LOOP_STAGE_LABELS } from '@growth-os/contracts';

const PRIORITY_TONE: Record<OpportunityPriority, 'critical' | 'attention' | 'neutral'> = {
  critical: 'critical',
  high: 'attention',
  medium: 'neutral',
  low: 'neutral',
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    maximumFractionDigits: 0,
  }).format(value);
}

export function OpportunityList({
  opportunities,
}: {
  opportunities: readonly GrowthOpportunity[];
}) {
  if (opportunities.length === 0) {
    return (
      <Surface level={1} className="p-8 text-center">
        <p className="text-body text-text-muted">No opportunities identified yet.</p>
        <p className="mt-1 text-caption text-text-subtle">
          Connect a data source so Growth AI has something to reason about.
        </p>
      </Surface>
    );
  }

  return (
    <ol className="flex flex-col gap-3">
      {opportunities.map((opportunity, index) => (
        <li key={opportunity.id}>
          <OpportunityCard opportunity={opportunity} rank={index + 1} />
        </li>
      ))}
    </ol>
  );
}

function OpportunityCard({ opportunity, rank }: { opportunity: GrowthOpportunity; rank: number }) {
  return (
    <Surface level={1} interactive className="p-5">
      <div className="flex items-start gap-4">
        <span
          className="mt-0.5 font-mono text-caption text-text-subtle tabular-nums"
          aria-label={`Rank ${rank}`}
        >
          {String(rank).padStart(2, '0')}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-text">{opportunity.title}</h3>
            <Badge tone={PRIORITY_TONE[opportunity.priority]}>{opportunity.priority}</Badge>
            <Badge tone="neutral">{GROWTH_LOOP_STAGE_LABELS[opportunity.stage]}</Badge>
            {opportunity.provenance === 'fixture' ? <Badge tone="fixture">Demo</Badge> : null}
          </div>

          <p className="mt-2 text-body text-text-muted">{opportunity.summary}</p>

          <p className="mt-3 border-l-2 border-signal-dim pl-3 text-body text-text">
            {opportunity.recommendation}
          </p>

          <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-caption text-text-subtle">
            {opportunity.estimatedMonthlyValue !== null ? (
              <span>
                Estimated impact{' '}
                <span className="font-mono text-text-muted tabular-nums">
                  {formatCurrency(opportunity.estimatedMonthlyValue)}
                </span>
                /month
              </span>
            ) : null}
            <span>Confidence {opportunity.confidence}</span>
          </div>

          {/* Native <details>: keyboard operable and screen-reader announced
              with no JavaScript and no ARIA of our own. */}
          <details className="group mt-3">
            <summary className="cursor-pointer list-none text-caption text-text-muted transition-colors duration-[120ms] hover:text-text focus-visible:outline-none">
              <span className="inline-flex items-center gap-1">
                <span className="transition-transform duration-[120ms] group-open:rotate-90">
                  ›
                </span>
                Why we think this ({opportunity.evidence.length} signals)
              </span>
            </summary>

            <dl className="mt-2.5 grid gap-x-6 gap-y-2 border-t border-line pt-3 sm:grid-cols-2">
              {opportunity.evidence.map((item) => (
                <div key={`${item.label}-${item.value}`} className="flex flex-col gap-0.5">
                  <dt className="text-caption text-text-subtle">{item.label}</dt>
                  <dd className="font-mono text-sm text-text tabular-nums">
                    {item.value}
                    {/* The source is always shown. An unsourced number is
                        exactly what this product exists not to produce. */}
                    <span className="ml-2 font-sans text-caption font-normal text-text-subtle">
                      {item.source}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </div>
    </Surface>
  );
}
