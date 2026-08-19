/**
 * Acquisition provenance — the contract that makes attribution possible.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Every path that creates an acquisition — website forms, tracked calls, voice
 * AI, imports, the API, manual entry — supplies this shape. Making it one
 * validated contract is what stops each ingestion path inventing its own
 * half-complete notion of "source".
 *
 * THE RULE THAT MATTERS MOST
 * `searchQuery` may only be set when a source system authoritatively told us
 * the query. It is never derived, never inferred, never guessed. Organic search
 * engines have not passed the query in the referrer since 2011; a keyword in
 * this field that did not come from Search Console or an Ads platform would
 * fabricate the single number this product's value rests on.
 *
 * @see docs/decisions/ADR-0012-provenance-model.md
 */

import { z } from 'zod';
import {
  PROVENANCE_CONFIDENCE,
  SOURCE_PLATFORMS,
  SOURCE_TYPES,
  type ProvenanceConfidence,
} from './enums';

/** Bounds on free-text provenance fields. Attacker-influenced input must not be unbounded. */
const MAX_URL_LENGTH = 2048;
const MAX_UTM_LENGTH = 255;

/**
 * Landing page, stored as a PATH with the query string removed.
 *
 * Query strings routinely carry personal data — email addresses in
 * click-through links, prefilled form values, session identifiers. Storing the
 * full URL would import PII into a column no retention policy covers. UTM
 * parameters are extracted into their own typed fields first; the remainder is
 * discarded.
 */
export const landingPathSchema = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .refine((value) => value.startsWith('/'), 'Landing page must be a path beginning with "/"')
  .refine((value) => !value.includes('?'), 'Landing page must not include a query string');

export const provenanceSchema = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  sourcePlatform: z.enum(SOURCE_PLATFORMS).default('unknown'),

  /**
   * Required, with no default. An ingestion path must state how much its own
   * data can be trusted — defaulting this would let every source silently
   * claim the highest confidence.
   */
  confidence: z.enum(PROVENANCE_CONFIDENCE),

  landingPath: landingPathSchema.optional(),

  /** Origin only, never the full referring URL (which can carry PII in its query). */
  referrerOrigin: z.string().trim().max(MAX_URL_LENGTH).optional(),

  utmSource: z.string().trim().max(MAX_UTM_LENGTH).optional(),
  utmMedium: z.string().trim().max(MAX_UTM_LENGTH).optional(),
  utmCampaign: z.string().trim().max(MAX_UTM_LENGTH).optional(),
  utmTerm: z.string().trim().max(MAX_UTM_LENGTH).optional(),
  utmContent: z.string().trim().max(MAX_UTM_LENGTH).optional(),

  /** Google / Facebook click identifiers. Opaque to us; strong signals when present. */
  gclid: z.string().trim().max(MAX_UTM_LENGTH).optional(),
  fbclid: z.string().trim().max(MAX_UTM_LENGTH).optional(),

  /**
   * The actual search query, when — and only when — a source system told us.
   * See the file header. Enforced by `assertProvenanceIntegrity` below.
   */
  searchQuery: z.string().trim().max(MAX_UTM_LENGTH).optional(),

  /** Human-meaningful channel detail: the tracked number dialled, the form name. */
  channelDetail: z.string().trim().max(255).optional(),

  /**
   * Bounded extra context. NOT a junk drawer: at most 20 keys, scalar values
   * only, each capped. An unrestricted JSON column is where PII goes to hide
   * from retention and deletion policies.
   */
  metadata: z
    .record(z.string().max(64), z.union([z.string().max(512), z.number(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 20, 'At most 20 metadata keys')
    .optional(),
});

export type ProvenanceInput = z.input<typeof provenanceSchema>;
export type Provenance = z.output<typeof provenanceSchema>;

/**
 * Enforce the integrity rules that a field-level schema cannot express.
 *
 * Separate from the schema because it is a cross-field invariant, and because
 * it must be callable independently by ingestion paths that build provenance
 * programmatically.
 *
 * @throws Error when a rule is violated. Callers convert to ValidationError.
 */
export function assertProvenanceIntegrity(provenance: Provenance): void {
  // THE search_query RULE. A query that did not come from an authoritative
  // source is a fabricated metric, not an incomplete one.
  if (provenance.searchQuery !== undefined && provenance.confidence !== 'declared') {
    throw new Error(
      'searchQuery may only be set when confidence is "declared" — a search term that was ' +
        'not reported by a source system would be fabricated. See ADR-0012.',
    );
  }

  // Paid-search click IDs cannot legitimately arrive on an organic acquisition;
  // this catches an ingestion path mislabelling its own channel.
  if (provenance.gclid !== undefined && provenance.sourceType === 'organic_search') {
    throw new Error('gclid indicates a paid click; sourceType must not be organic_search.');
  }
}

/**
 * Confidence values that may be presented to a user without a caveat.
 *
 * `inferred` is deliberately excluded: anything we guessed must be visibly
 * labelled at the point of display, not quietly rendered as fact.
 */
const UNQUALIFIED_CONFIDENCE: ReadonlySet<ProvenanceConfidence> = new Set(['declared', 'manual']);

export function requiresConfidenceCaveat(confidence: ProvenanceConfidence): boolean {
  return !UNQUALIFIED_CONFIDENCE.has(confidence);
}

/**
 * Split a raw URL into a storable landing path plus UTM parameters.
 *
 * ⚠️ NO CALLERS. This is not wired to anything, and the claim it used to make —
 * "used by ingestion paths that receive a full URL from a browser… centralised
 * so that no caller stores a raw URL by accident" — was false in a way that
 * mattered, because **another function is doing that job on the live path.**
 *
 * Verified in dev log 0024: the lead-capture path runs
 * `submit.ts` → `sanitise.ts` → `toPath`, not this. Measured over 13 inputs,
 * the two disagree about whether to accept **7** of them. `toPath` resolves
 * anything `new URL(x, base)` will swallow, so it stores `/::::` for `::::`,
 * `a@b.test` for `mailto:a@b.test` and `alert(1)` for `javascript:alert(1)` —
 * which is precisely the failure the comment below this docstring says the
 * shape check exists to prevent.
 *
 * ⚠️ That is a defect in `toPath`, on the live path, and it is NOT fixed here:
 * it changes what lead capture stores and needs its own brief. Recorded so the
 * next author does not read this function's promise and assume it is kept.
 *
 * Returns `null` for an unparseable URL rather than throwing: a malformed
 * referrer is normal and must not fail an acquisition.
 */
/**
 * The one definition of "what is the landing path for this URL?".
 *
 * ⚠️ THIS EXISTS BECAUSE THERE WERE TWO, AND THE LIVE ONE WAS THE PERMISSIVE
 * ONE. `toPath` in `@growth-os/forms` answered the same question by calling
 * `new URL()` and trusting it to throw. It does not throw: it **resolves**
 * almost any string against the base. Measured over 13 inputs the two disagreed
 * about 7, and every one of those was written to `acquisitions.landing_path`
 * (dev log 0024, re-measured in 0025).
 *
 * Both callers now share this step, so they cannot drift apart again — asserted
 * as a property in `public-path.test.ts` rather than left to review.
 *
 * ⚠️ THE SHAPE CHECK COMES BEFORE THE PARSE, and that ordering is the fix.
 * Only an absolute `http(s)` URL or a rooted path is a plausible landing
 * target. `javascript:alert(1)`, `mailto:`, `tel:`, `data:` and `::::` all
 * parse — into a `pathname` that is not a path.
 *
 * Returns `null` rather than throwing, and **rather than guessing**: a
 * malformed referrer is normal traffic and must not fail an acquisition. The
 * caller drops the field and keeps the lead.
 *
 * ⚠️ NO LENGTH CAP HERE. Each caller stores into a different column with a
 * different bound, and a cap applied twice at different widths is how they stop
 * agreeing.
 *
 * @see docs/decisions/ADR-0044-one-landing-path-normaliser.md
 */
export function landingPathOf(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;

  // ⚠️ SHAPE BEFORE PARSE. `new URL(x, base)` resolves almost any string
  // against the base rather than throwing, so relying on the throw alone
  // happily turns '::::' into the landing path '/::::' and stores it.
  const looksAbsolute = /^https?:\/\//i.test(trimmed);
  if (!looksAbsolute && !trimmed.startsWith('/')) return null;

  let url: URL;
  try {
    url = new URL(trimmed, 'https://placeholder.invalid');
  } catch {
    return null;
  }

  // A parsed URL always has a pathname, but never assume it: an empty one is
  // the root, and storing '' would be a third spelling of '/'.
  return url.pathname.length === 0 ? '/' : url.pathname;
}

export function splitLandingUrl(rawUrl: string): {
  landingPath: string;
  utm: Pick<Provenance, 'utmSource' | 'utmMedium' | 'utmCampaign' | 'utmTerm' | 'utmContent'>;
  gclid: string | undefined;
  fbclid: string | undefined;
} | null {
  const trimmed = rawUrl.trim();

  const landingPath = landingPathOf(trimmed);
  if (landingPath === null) return null;

  let url: URL;
  try {
    url = new URL(trimmed, 'https://placeholder.invalid');
  } catch {
    return null;
  }

  const read = (key: string): string | undefined => {
    const value = url.searchParams.get(key);
    return value === null || value.length === 0 ? undefined : value.slice(0, MAX_UTM_LENGTH);
  };

  return {
    landingPath: landingPath.slice(0, MAX_URL_LENGTH),
    utm: {
      utmSource: read('utm_source'),
      utmMedium: read('utm_medium'),
      utmCampaign: read('utm_campaign'),
      utmTerm: read('utm_term'),
      utmContent: read('utm_content'),
    },
    gclid: read('gclid'),
    fbclid: read('fbclid'),
  };
}
