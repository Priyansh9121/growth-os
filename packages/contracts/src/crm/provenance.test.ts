/**
 * Provenance integrity.
 *
 * The `searchQuery` rule is the single most important assertion in Stage 2.
 * A fabricated keyword corrupts the exact number Growth OS is sold on — the
 * link between a search term and revenue — and it would be indistinguishable
 * from a real one once stored.
 *
 * @see docs/decisions/ADR-0012-provenance-model.md
 */

import { describe, expect, it } from 'vitest';
import {
  assertProvenanceIntegrity,
  provenanceSchema,
  requiresConfidenceCaveat,
  splitLandingUrl,
} from './provenance';

function build(overrides: Record<string, unknown> = {}) {
  return provenanceSchema.parse({
    sourceType: 'organic_search',
    sourcePlatform: 'google',
    confidence: 'derived',
    ...overrides,
  });
}

describe('searchQuery may only accompany DECLARED provenance', () => {
  it('REJECTS a search query on derived provenance', () => {
    // Search engines have not passed the query in the referrer since 2011.
    // A keyword on derived provenance was invented by us.
    expect(() =>
      assertProvenanceIntegrity(
        build({ confidence: 'derived', searchQuery: 'emergency plumber melbourne' }),
      ),
    ).toThrow(/searchQuery may only be set when confidence is "declared"/);
  });

  it('REJECTS a search query on inferred provenance', () => {
    expect(() =>
      assertProvenanceIntegrity(build({ confidence: 'inferred', searchQuery: 'blocked drain' })),
    ).toThrow(/declared/);
  });

  it('REJECTS a search query on manual provenance', () => {
    // Even a human typing it in is not a source system reporting it.
    expect(() =>
      assertProvenanceIntegrity(build({ confidence: 'manual', searchQuery: 'hot water' })),
    ).toThrow(/declared/);
  });

  it('ACCEPTS a search query on declared provenance', () => {
    // An Ads platform reports the keyword that triggered the click. This is
    // the only legitimate origin for the field.
    expect(() =>
      assertProvenanceIntegrity(
        build({
          sourceType: 'paid_search',
          confidence: 'declared',
          searchQuery: 'blocked drain emergency melbourne',
        }),
      ),
    ).not.toThrow();
  });

  it('ACCEPTS declared provenance with NO search query — the common case', () => {
    expect(() => assertProvenanceIntegrity(build({ confidence: 'declared' }))).not.toThrow();
  });
});

describe('channel consistency', () => {
  it('rejects a paid-click id on an organic acquisition', () => {
    // A gclid means the click was paid. Its presence on an organic-labelled
    // acquisition means an ingestion path mislabelled its own channel.
    expect(() =>
      assertProvenanceIntegrity(build({ sourceType: 'organic_search', gclid: 'abc123' })),
    ).toThrow(/gclid indicates a paid click/);
  });

  it('accepts a gclid on a paid-search acquisition', () => {
    expect(() =>
      assertProvenanceIntegrity(build({ sourceType: 'paid_search', gclid: 'abc123' })),
    ).not.toThrow();
  });
});

describe('landing path', () => {
  it('rejects a value carrying a query string', () => {
    // Query strings routinely contain PII — email addresses in click-through
    // links, prefilled form values. Storing the full URL would import personal
    // data into a column no retention policy covers.
    expect(() => build({ landingPath: '/contact?email=sarah@example.test' })).toThrow();
  });

  it('rejects an absolute URL', () => {
    expect(() => build({ landingPath: 'https://example.test/contact' })).toThrow();
  });

  it('accepts a bare path', () => {
    expect(build({ landingPath: '/emergency-plumber-melbourne' }).landingPath).toBe(
      '/emergency-plumber-melbourne',
    );
  });
});

describe('splitLandingUrl', () => {
  it('separates path from UTM parameters and drops the rest', () => {
    const result = splitLandingUrl(
      'https://abcplumbing.test/blocked-drains?utm_source=google&utm_campaign=drains&email=sarah@example.test',
    );

    expect(result?.landingPath).toBe('/blocked-drains');
    expect(result?.utm.utmSource).toBe('google');
    expect(result?.utm.utmCampaign).toBe('drains');
    // The email in the query string is DISCARDED, not stored anywhere.
    expect(JSON.stringify(result)).not.toContain('sarah@example.test');
  });

  it('extracts click identifiers', () => {
    const result = splitLandingUrl('https://x.test/p?gclid=GC123&fbclid=FB456');
    expect(result?.gclid).toBe('GC123');
    expect(result?.fbclid).toBe('FB456');
  });

  it('returns null for unparseable input rather than throwing', () => {
    // A malformed referrer is normal and must never fail an acquisition.
    expect(splitLandingUrl('::::')).toBeNull();
  });
});

describe('metadata bounds', () => {
  it('rejects more than 20 keys', () => {
    // An unrestricted JSON column is where PII hides from retention policies.
    const tooMany = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`key${index}`, 'value']),
    );
    expect(() => build({ metadata: tooMany })).toThrow();
  });

  it('accepts a bounded metadata object', () => {
    expect(() => build({ metadata: { formId: 'contact-form', variant: 2 } })).not.toThrow();
  });
});

describe('requiresConfidenceCaveat', () => {
  it('flags derived and inferred provenance for visible qualification', () => {
    expect(requiresConfidenceCaveat('derived')).toBe(true);
    expect(requiresConfidenceCaveat('inferred')).toBe(true);
  });

  it('does not flag declared or manual provenance', () => {
    // Both were reported by something that knew, so they render unqualified.
    expect(requiresConfidenceCaveat('declared')).toBe(false);
    expect(requiresConfidenceCaveat('manual')).toBe(false);
  });
});

describe('confidence is required', () => {
  it('cannot be omitted', () => {
    // No default: an ingestion path must state how much its own data can be
    // trusted, or every source would silently claim the highest confidence.
    expect(() =>
      provenanceSchema.parse({ sourceType: 'organic_search', sourcePlatform: 'google' }),
    ).toThrow();
  });
});
