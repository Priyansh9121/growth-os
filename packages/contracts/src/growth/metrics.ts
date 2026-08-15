/**
 * Types for the growth loop's measurable surface.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * These are the shapes the dashboard renders and the shapes the AI's read
 * tools return. Defining them before the data sources exist is deliberate: it
 * forces the dashboard, the fixtures and the future ingestion pipeline to
 * agree on one vocabulary, and it makes the eventual swap from fixtures to
 * live data a change of *source*, not of *shape*.
 *
 * PRINCIPLE 3 IS ENCODED IN THE TYPES
 * `MetricValue` cannot represent a number without also declaring its
 * provenance. There is no way to render a metric in this product without
 * stating whether it is live, an estimate, unavailable, or a fixture — because
 * the type system will not let you construct one.
 *
 * @see docs/product/product-principles.md (Principle 3: never fabricate a number)
 */

/**
 * Where a number came from. Rendered as a visible badge whenever it is not
 * `live`, so a demo value can never be mistaken for a measurement.
 */
export type MetricProvenance =
  /** Measured from a connected source. */
  | 'live'
  /** Derived by a documented model, not directly observed. */
  | 'estimate'
  /** The source is not connected. Renders as "Not connected" — NEVER as zero. */
  | 'unavailable'
  /** Development fixture. Must be visibly labelled in the UI. */
  | 'fixture';

/** Direction of change, where the *meaning* of up/down depends on the metric. */
export type TrendDirection = 'up' | 'down' | 'flat';

/** Whether an increase in this metric is good. Missed calls going up is bad. */
export type TrendPolarity = 'higher_is_better' | 'lower_is_better' | 'neutral';

export interface MetricDelta {
  /** Change against the comparison period, as a percentage. */
  readonly percent: number;
  readonly direction: TrendDirection;
  /** Human description of the comparison window, e.g. "vs previous 30 days". */
  readonly comparisonLabel: string;
}

/**
 * A single number, with everything needed to render it honestly.
 *
 * `value` is nullable and MUST be null when provenance is `unavailable`. A
 * missing measurement is not zero, and displaying it as zero is the most
 * common way analytics products mislead their users.
 */
export interface MetricValue {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly formatted: string;
  readonly unit: 'count' | 'currency' | 'percent' | 'score' | 'duration_seconds';
  readonly provenance: MetricProvenance;
  readonly polarity: TrendPolarity;
  readonly delta?: MetricDelta;
  /** One line explaining what this measures, shown on hover/expand. */
  readonly description?: string;
}

/** How confident the system is in a derived judgement. */
export type Confidence = 'low' | 'medium' | 'high';

export type OpportunityPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * A single piece of evidence behind a recommendation.
 *
 * Principle 4: every recommendation carries its evidence. A recommendation
 * without at least one `EvidenceItem` is not renderable — the UI requires a
 * non-empty array.
 */
export interface EvidenceItem {
  readonly label: string;
  readonly value: string;
  /** Where this came from, e.g. "Google Search Console", "Call log". */
  readonly source: string;
}

/**
 * A ranked, quantified chance to increase revenue.
 *
 * Distinct from a `Finding` ("this is technically wrong") — an opportunity has
 * a monetary argument. See docs/product/terminology.md.
 */
export interface GrowthOpportunity {
  readonly id: string;
  readonly title: string;
  /** Which loop stage this acts on. */
  readonly stage: GrowthLoopStage;
  readonly priority: OpportunityPriority;
  /** Plain-language statement of what is happening and why it matters. */
  readonly summary: string;
  /** The proposed action. */
  readonly recommendation: string;
  /** Non-empty by contract. */
  readonly evidence: readonly EvidenceItem[];
  readonly confidence: Confidence;
  /** Estimated monthly revenue impact, when it can be derived. Null otherwise. */
  readonly estimatedMonthlyValue: number | null;
  readonly provenance: MetricProvenance;
}

/** The seven stages of the growth loop. Every feature declares one. */
export const GROWTH_LOOP_STAGES = [
  'get_found',
  'get_traffic',
  'capture',
  'convert',
  'book_sell',
  'measure',
  'optimise',
] as const;

export type GrowthLoopStage = (typeof GROWTH_LOOP_STAGES)[number];

export const GROWTH_LOOP_STAGE_LABELS: Readonly<Record<GrowthLoopStage, string>> = {
  get_found: 'Get found',
  get_traffic: 'Get traffic',
  capture: 'Capture',
  convert: 'Convert',
  book_sell: 'Book / Sell',
  measure: 'Measure',
  optimise: 'Optimise',
};

/**
 * The complete payload for the dashboard home screen and for the AI's
 * `growth.getSnapshot` read tool.
 *
 * One shape serving both is intentional: the AI reasons over exactly what the
 * user can see, so it can never cite a number the user cannot verify on screen.
 */
export interface GrowthSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly periodLabel: string;
  /** ISO-8601. Generated server-side so client clock skew cannot alter it. */
  readonly generatedAt: string;
  /**
   * Overall provenance. When `fixture`, the UI MUST render a prominent
   * demo-data banner — this flag is what the dashboard keys that banner off.
   */
  readonly provenance: MetricProvenance;
  readonly headline: MetricValue;
  readonly metrics: readonly MetricValue[];
  readonly opportunities: readonly GrowthOpportunity[];
}
