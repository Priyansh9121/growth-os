/**
 * Provenance rendering primitives.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The only components that render an acquisition source. Centralised so that
 * the confidence rule is applied everywhere it should be, rather than depending
 * on each screen remembering it.
 *
 * PRINCIPLE 3, APPLIED TO PROVENANCE
 * A source derived from browser signals or inferred by a heuristic is shown
 * with a visible qualifier. Only `declared` and `manual` provenance renders
 * unqualified, because only those were actually reported by something that
 * knew. See `requiresConfidenceCaveat` in @growth-os/contracts.
 *
 * @see docs/decisions/ADR-0012-provenance-model.md
 */

import { Badge } from '@growth-os/ui';
import {
  requiresConfidenceCaveat,
  SOURCE_TYPE_LABELS,
  type ContactSourceView,
  type ProvenanceConfidence,
  type SourceType,
} from '@growth-os/contracts';

/**
 * Tone by acquisition channel.
 *
 * `signal` marks channels Growth OS can act on to produce more of the same —
 * organic, local, voice. Neutral for everything else. This is a deliberate
 * visual hierarchy, not decoration: the accent draws the eye to the sources
 * the product is built to grow.
 */
const SOURCE_TONE: Partial<Record<SourceType, 'signal' | 'attention' | 'neutral'>> = {
  organic_search: 'signal',
  google_business_profile: 'signal',
  voice: 'signal',
  paid_search: 'attention',
  social: 'attention',
};

export function SourceBadge({ source }: { source: ContactSourceView | null }) {
  if (!source) {
    // "Unknown" is a legitimate, common state. It renders as an honest absence
    // rather than a guess — never an inferred channel.
    return (
      <span className="text-caption text-text-subtle" title="No acquisition recorded">
        Not recorded
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={SOURCE_TONE[source.sourceType] ?? 'neutral'}>
        {SOURCE_TYPE_LABELS[source.sourceType]}
      </Badge>
      <ConfidenceMark confidence={source.confidence} />
    </span>
  );
}

/**
 * Marks provenance that was not authoritatively reported.
 *
 * Renders nothing for `declared` and `manual` — the common case stays quiet,
 * so the qualifier means something when it appears.
 */
export function ConfidenceMark({ confidence }: { confidence: ProvenanceConfidence }) {
  if (!requiresConfidenceCaveat(confidence)) return null;

  const label =
    confidence === 'inferred'
      ? 'Inferred by Growth OS — not reported by the source'
      : 'Derived from browser signals — may be incomplete';

  return (
    <span
      title={label}
      aria-label={label}
      className="cursor-help font-mono text-overline text-text-subtle"
    >
      {confidence === 'inferred' ? '~' : '≈'}
    </span>
  );
}

/** Compact source line for the contact detail header. */
export function SourceSummary({ source }: { source: ContactSourceView | null }) {
  if (!source) return <span className="text-body text-text-subtle">Not recorded</span>;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-body text-text">{SOURCE_TYPE_LABELS[source.sourceType]}</span>
      {source.landingPath ? (
        <code className="font-mono text-caption text-text-muted">{source.landingPath}</code>
      ) : null}
      <ConfidenceMark confidence={source.confidence} />
    </span>
  );
}
