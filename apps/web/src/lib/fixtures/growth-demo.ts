/**
 * Development fixtures for the dashboard.
 *
 * ⚠️  EVERY VALUE IN THIS FILE IS INVENTED. NONE OF IT IS MEASURED.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Provides a `GrowthSnapshot` so the dashboard shell can be built, reviewed and
 * tested before any data source exists (Stages 3–15).
 *
 * HOW PRINCIPLE 3 IS ENFORCED HERE
 * Every metric carries `provenance: 'fixture'` and the snapshot itself is
 * marked `'fixture'`. The dashboard keys a prominent, non-dismissible banner
 * off that flag, and `MetricValue` cannot be constructed without declaring
 * provenance — so it is not possible to render one of these numbers as though
 * it were measured, even by mistake.
 *
 * WHEN THE REAL SOURCES ARRIVE
 * This module is replaced by a query, not edited. The shape is already the
 * production shape, so the swap is a change of source only.
 *
 * @see docs/product/product-principles.md (Principle 3)
 * @see packages/contracts/src/growth/metrics.ts
 */

import type { GrowthSnapshot, GrowthOpportunity, MetricValue } from '@growth-os/contracts';

const FIXTURE_METRICS: readonly MetricValue[] = [
  {
    key: 'organic_leads',
    label: 'Organic leads',
    value: 47,
    formatted: '47',
    unit: 'count',
    provenance: 'fixture',
    polarity: 'higher_is_better',
    delta: { percent: 21, direction: 'up', comparisonLabel: 'vs previous 30 days' },
    description: 'Enquiries attributed to organic search.',
  },
  {
    key: 'calls',
    label: 'Tracked calls',
    value: 36,
    formatted: '36',
    unit: 'count',
    provenance: 'fixture',
    polarity: 'higher_is_better',
    delta: { percent: 12, direction: 'up', comparisonLabel: 'vs previous 30 days' },
  },
  {
    key: 'appointments',
    label: 'Appointments',
    value: 18,
    formatted: '18',
    unit: 'count',
    provenance: 'fixture',
    polarity: 'higher_is_better',
    delta: { percent: 6, direction: 'up', comparisonLabel: 'vs previous 30 days' },
  },
  {
    key: 'attributed_revenue',
    label: 'Attributed revenue',
    value: 18_420,
    formatted: '$18,420',
    unit: 'currency',
    provenance: 'fixture',
    polarity: 'higher_is_better',
    delta: { percent: 18, direction: 'up', comparisonLabel: 'vs previous 30 days' },
    // Terminology rule: attributed revenue is never shown without its model.
    description: 'Last non-direct attribution model.',
  },
  {
    key: 'missed_calls',
    label: 'Missed calls',
    value: 11,
    formatted: '11',
    unit: 'count',
    provenance: 'fixture',
    // Missed calls rising is bad — polarity drives the delta's colour, so an
    // increase renders as a warning rather than as success.
    polarity: 'lower_is_better',
    delta: { percent: 9, direction: 'up', comparisonLabel: 'vs previous 30 days' },
  },
  {
    key: 'seo_visibility',
    label: 'SEO visibility',
    value: null,
    // Demonstrates the "unavailable" state: no source is connected, so this
    // shows as not connected rather than as zero. Rendering a missing
    // measurement as 0% is the single most common way analytics products
    // mislead their users.
    formatted: 'Not connected',
    unit: 'percent',
    provenance: 'unavailable',
    polarity: 'higher_is_better',
    description: 'Connect Google Search Console to measure visibility.',
  },
];

const FIXTURE_OPPORTUNITIES: readonly GrowthOpportunity[] = [
  {
    id: 'opp-page-quality-emergency-plumber',
    title: 'Improve the emergency plumbing landing page',
    stage: 'get_traffic',
    priority: 'high',
    summary:
      'This page already receives qualified demand and converts well, but loads slowly on mobile and is missing service-area markup.',
    recommendation:
      'Optimise the existing page rather than publishing new content. The demand is already arriving and leaking on arrival.',
    evidence: [
      { label: 'Current position', value: '#7', source: 'Rank tracking (fixture)' },
      { label: 'Leads last 30 days', value: '8', source: 'Lead capture (fixture)' },
      { label: 'Mobile LCP', value: '4.1s', source: 'PageSpeed Insights (fixture)' },
      { label: 'Service-area schema', value: 'Missing', source: 'Site audit (fixture)' },
    ],
    confidence: 'medium',
    estimatedMonthlyValue: 2400,
    provenance: 'fixture',
  },
  {
    id: 'opp-missed-calls',
    title: 'Enable the AI receptionist for missed calls',
    stage: 'capture',
    priority: 'critical',
    summary:
      '11 calls went unanswered last month. Around 5 are likely to have been genuine enquiries that went elsewhere.',
    recommendation:
      'Turn on the AI receptionist for calls unanswered after 20 seconds, so out-of-hours and on-site enquiries are captured and booked.',
    evidence: [
      { label: 'Missed calls', value: '11', source: 'Call tracking (fixture)' },
      { label: 'Answered call → appointment rate', value: '47%', source: 'CRM (fixture)' },
      { label: 'Average job value', value: '$460', source: 'CRM (fixture)' },
    ],
    confidence: 'high',
    estimatedMonthlyValue: 2300,
    provenance: 'fixture',
  },
  {
    id: 'opp-review-velocity',
    title: 'Review velocity has fallen behind the local average',
    stage: 'get_found',
    priority: 'medium',
    summary:
      'Two new reviews in the last 30 days against a local competitor average of nine. Review volume correlates strongly with map-pack position.',
    recommendation: 'Send an automated review request 24 hours after each completed job.',
    evidence: [
      { label: 'Reviews last 30 days', value: '2', source: 'Google Business Profile (fixture)' },
      { label: 'Competitor average', value: '9', source: 'Competitor tracking (fixture)' },
      { label: 'Map-pack position', value: '#6', source: 'Local rankings (fixture)' },
    ],
    confidence: 'medium',
    estimatedMonthlyValue: null,
    provenance: 'fixture',
  },
];

/**
 * Build the demo snapshot for a workspace.
 *
 * `generatedAt` is passed in rather than read from the clock so that server and
 * client renders agree — a `new Date()` here would produce a hydration
 * mismatch on every page load.
 */
export function buildFixtureSnapshot(
  workspaceId: string,
  workspaceName: string,
  generatedAt: string,
): GrowthSnapshot {
  return {
    workspaceId,
    workspaceName,
    periodLabel: 'Last 30 days',
    generatedAt,
    provenance: 'fixture',
    headline: {
      key: 'growth_score',
      label: 'Growth score',
      value: 82,
      formatted: '82',
      unit: 'score',
      provenance: 'fixture',
      polarity: 'higher_is_better',
      delta: { percent: 4, direction: 'up', comparisonLabel: 'vs previous 30 days' },
      description: 'Composite of visibility, capture, conversion and revenue signals.',
    },
    metrics: FIXTURE_METRICS,
    opportunities: FIXTURE_OPPORTUNITIES,
  };
}
