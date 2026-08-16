/**
 * Deterministic source classification.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turns untrusted browser signals into a provenance record the product is
 * willing to report as fact.
 *
 * THE BROWSER NEVER STATES THE SOURCE
 * `sourceType`, `sourcePlatform` and `confidence` do not appear in
 * `submissionContextSchema` at all. A page could otherwise post
 * `sourceType: 'organic_search'` and the CRM would believe it — which would
 * make every attribution report a claim about what a website asserted rather
 * than what happened.
 *
 * What the browser sends is raw: a referrer origin, some UTM parameters, maybe
 * a click id. This function decides what those MEAN, by rules written down
 * here and testable in isolation.
 *
 * ⚠️ NO LLM. Attribution classification is deterministic code, forever. A model
 * that is right 95% of the time produces a report that is wrong 5% of the time
 * in ways nobody can audit, about the number this product is sold on.
 *
 * @see docs/decisions/ADR-0012-provenance-model.md
 */

import type { ProvenanceConfidence, SourcePlatform, SourceType } from '../crm/enums';
import type { SubmissionContext } from './schemas';

export interface ClassifiedSource {
  readonly sourceType: SourceType;
  readonly sourcePlatform: SourcePlatform;
  readonly confidence: ProvenanceConfidence;
  /** One sentence, for the operator. Rendered on the acquisition. */
  readonly rationale: string;
}

/**
 * Hosts we recognise as search engines.
 *
 * A SHORT, EXPLICIT LIST. The alternative — treating any host containing
 * "search" as a search engine — misclassifies `researchgate.net` and
 * `searchenginejournal.com`, both of which are referrals.
 */
const SEARCH_ENGINE_HOSTS: Readonly<Record<string, SourcePlatform>> = {
  'google.com': 'google',
  'google.com.au': 'google',
  'google.co.uk': 'google',
  'google.ca': 'google',
  'google.co.nz': 'google',
  'bing.com': 'bing',
  'duckduckgo.com': 'unknown',
  'search.yahoo.com': 'unknown',
  'ecosia.org': 'unknown',
  'brave.com': 'unknown',
};

const SOCIAL_HOSTS: Readonly<Record<string, SourcePlatform>> = {
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'linkedin.com': 'linkedin',
  't.co': 'unknown',
  'x.com': 'unknown',
  'reddit.com': 'unknown',
  'youtube.com': 'unknown',
  'pinterest.com': 'unknown',
  'tiktok.com': 'unknown',
};

/** Paid-intent UTM mediums, lowercased. */
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'cpm', 'display']);

/**
 * Reduce a referrer origin to a bare host for matching.
 *
 * Returns null rather than guessing when the value is not parseable — a
 * mangled referrer must not become a confident classification.
 */
export function referrerHost(referrerOrigin: string | undefined): string | null {
  if (!referrerOrigin) return null;

  try {
    const withScheme = /^https?:\/\//i.test(referrerOrigin)
      ? referrerOrigin
      : `https://${referrerOrigin}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/** Match a host against a table, allowing subdomains (`m.facebook.com`). */
function lookupHost(
  host: string | null,
  table: Readonly<Record<string, SourcePlatform>>,
): SourcePlatform | null {
  if (host === null) return null;
  const direct = table[host];
  if (direct !== undefined) return direct;

  for (const [candidate, platform] of Object.entries(table)) {
    // `endsWith('.' + candidate)` rather than `includes`: `notgoogle.com`
    // must not match `google.com`.
    if (host.endsWith(`.${candidate}`)) return platform;
  }
  return null;
}

/**
 * Classify one submission's context.
 *
 * The rules are ORDERED, and the order is the specification. Each returns the
 * strongest claim the evidence actually supports.
 */
export function classifySource(context: SubmissionContext): ClassifiedSource {
  const host = referrerHost(context.referrerOrigin);
  const medium = context.utmMedium?.toLowerCase().trim();
  const source = context.utmSource?.toLowerCase().trim();

  // 1. A CLICK ID IS THE STRONGEST SIGNAL AVAILABLE.
  //
  // `gclid` and `fbclid` are minted by the ad platform on an actual paid
  // click. They cannot be produced by browsing, and a page that fabricated one
  // would produce a value the platform will not recognise later — so this is
  // `declared`: an ad platform told us, through a token it issued.
  if (context.gclid) {
    return {
      sourceType: 'paid_search',
      sourcePlatform: 'google',
      confidence: 'declared',
      rationale: 'Arrived with a Google click identifier (gclid).',
    };
  }

  if (context.fbclid) {
    return {
      sourceType: 'social',
      sourcePlatform: 'facebook',
      confidence: 'declared',
      rationale: 'Arrived with a Meta click identifier (fbclid).',
    };
  }

  // 2. AN EXPLICIT PAID CAMPAIGN.
  //
  // `derived`, not `declared`: UTM parameters are written by whoever built the
  // link and are editable by anyone who copies it. They express the marketer's
  // INTENT reliably, and the click's reality only approximately.
  if (medium && PAID_MEDIUMS.has(medium)) {
    return {
      sourceType: source === 'google' || source === 'bing' ? 'paid_search' : 'social',
      sourcePlatform: platformFromUtmSource(source),
      confidence: 'derived',
      rationale: `Campaign link marked utm_medium=${medium}.`,
    };
  }

  // 3. AN EXPLICIT NON-PAID CAMPAIGN.
  if (medium === 'email' || source === 'email' || source === 'newsletter') {
    return {
      sourceType: 'email',
      sourcePlatform: 'unknown',
      confidence: 'derived',
      rationale: 'Campaign link marked as email.',
    };
  }

  if (medium === 'social' || medium === 'organic_social') {
    return {
      sourceType: 'social',
      sourcePlatform: platformFromUtmSource(source),
      confidence: 'derived',
      rationale: `Campaign link marked utm_medium=${medium}.`,
    };
  }

  // 4. A RECOGNISED SEARCH ENGINE REFERRER, WITHOUT A PAID MARKER.
  //
  // ⚠️ THIS IS ORGANIC SEARCH, AND IT IS NOT A KEYWORD.
  //
  // Search engines stopped passing the query in the referrer in 2011. We know
  // the visitor came from Google; we do NOT know what they searched for, and
  // nothing in this branch may pretend otherwise. `searchQuery` is not set
  // here or anywhere else in this file (ADR-0012).
  const searchPlatform = lookupHost(host, SEARCH_ENGINE_HOSTS);
  if (searchPlatform !== null) {
    return {
      sourceType: 'organic_search',
      sourcePlatform: searchPlatform,
      confidence: 'derived',
      rationale: `Referred by ${host}, with no paid campaign markers.`,
    };
  }

  // 5. A RECOGNISED SOCIAL REFERRER.
  const socialPlatform = lookupHost(host, SOCIAL_HOSTS);
  if (socialPlatform !== null) {
    return {
      sourceType: 'social',
      sourcePlatform: socialPlatform,
      confidence: 'derived',
      rationale: `Referred by ${host}.`,
    };
  }

  // 6. ANY OTHER SITE LINKED TO THEM.
  if (host !== null) {
    return {
      sourceType: 'referral',
      sourcePlatform: 'unknown',
      confidence: 'derived',
      rationale: `Referred by ${host}.`,
    };
  }

  // 7. A CAMPAIGN TAG WITH NO REFERRER — a QR code, a print ad, an offline URL.
  if (source || context.utmCampaign) {
    return {
      sourceType: 'unknown',
      sourcePlatform: platformFromUtmSource(source),
      confidence: 'derived',
      rationale: 'Campaign parameters present, but the channel is not identifiable.',
    };
  }

  // 8. NO REFERRER AND NO CAMPAIGN.
  //
  // `direct` with `inferred` confidence, and the rationale says why it is a
  // guess. This bucket genuinely contains typed-in URLs, bookmarks, and every
  // referrer the browser withheld — an app, a PDF, an HTTPS→HTTP downgrade,
  // or a strict referrer policy. Calling it "direct traffic" with confidence
  // would be the single most common attribution lie in the industry.
  return {
    sourceType: 'direct',
    sourcePlatform: 'unknown',
    confidence: 'inferred',
    rationale:
      'No referrer and no campaign parameters. This may be a direct visit, or a referrer the browser withheld.',
  };
}

function platformFromUtmSource(source: string | undefined): SourcePlatform {
  switch (source) {
    case 'google':
      return 'google';
    case 'bing':
      return 'bing';
    case 'facebook':
    case 'meta':
      return 'facebook';
    case 'instagram':
      return 'instagram';
    case 'linkedin':
      return 'linkedin';
    default:
      return 'unknown';
  }
}
