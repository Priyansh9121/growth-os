/**
 * Source classification.
 *
 * WHY THIS SUITE MATTERS MORE THAN ITS SIZE SUGGESTS
 * This function decides what every attribution report in the product will say.
 * It runs on untrusted input from a public web page, and its output is written
 * into an immutable provenance record.
 *
 * The most important tests here are the NEGATIVES — that a page cannot claim a
 * source, and that a search referrer never becomes a search keyword. Those are
 * the two ways this could quietly start lying.
 */

import { describe, expect, it } from 'vitest';
import { classifySource, referrerHost } from './classify-source';
import type { SubmissionContext } from './schemas';

const context = (overrides: Partial<SubmissionContext> = {}): SubmissionContext => overrides;

describe('referrerHost', () => {
  it.each([
    ['https://www.google.com/search?q=plumber', 'google.com'],
    ['https://google.com', 'google.com'],
    ['google.com', 'google.com'],
    ['https://m.facebook.com/x', 'm.facebook.com'],
  ])('reduces %s to %s', (input, expected) => {
    expect(referrerHost(input)).toBe(expected);
  });

  it('returns null rather than guessing at an unparseable value', () => {
    // A mangled referrer must not become a confident classification.
    expect(referrerHost('::::')).toBeNull();
    expect(referrerHost('')).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
  });
});

describe('classifySource', () => {
  describe('click identifiers are the strongest signal', () => {
    it('classifies a gclid as declared paid search', () => {
      // An ad platform minted this on an actual paid click. It cannot be
      // produced by browsing, which is what makes `declared` honest here.
      const result = classifySource(context({ gclid: 'Cj0KCQ' }));

      expect(result).toMatchObject({
        sourceType: 'paid_search',
        sourcePlatform: 'google',
        confidence: 'declared',
      });
    });

    it('classifies an fbclid as declared social', () => {
      expect(classifySource(context({ fbclid: 'IwAR0' }))).toMatchObject({
        sourceType: 'social',
        sourcePlatform: 'facebook',
        confidence: 'declared',
      });
    });

    it('prefers a click id over a conflicting referrer', () => {
      // A paid click that lands via a redirect can carry an unrelated
      // referrer. The token is the stronger evidence.
      const result = classifySource(
        context({ gclid: 'Cj0KCQ', referrerOrigin: 'https://www.bing.com' }),
      );

      expect(result.sourceType).toBe('paid_search');
      expect(result.sourcePlatform).toBe('google');
    });
  });

  describe('campaign parameters are derived, never declared', () => {
    it.each(['cpc', 'ppc', 'paid', 'paidsearch', 'cpm'])(
      'treats utm_medium=%s as paid',
      (medium) => {
        const result = classifySource(context({ utmMedium: medium, utmSource: 'google' }));

        expect(result.sourceType).toBe('paid_search');
        // `derived`, not `declared`: UTM parameters are written by whoever
        // built the link and are editable by anyone who copies it.
        expect(result.confidence).toBe('derived');
      },
    );

    it('classifies an email campaign', () => {
      expect(classifySource(context({ utmMedium: 'email' }))).toMatchObject({
        sourceType: 'email',
        confidence: 'derived',
      });
    });
  });

  describe('search referrers', () => {
    it.each([
      ['https://www.google.com', 'google'],
      ['https://www.google.com.au', 'google'],
      ['https://www.bing.com', 'bing'],
      ['https://duckduckgo.com', 'unknown'],
    ])('classifies %s as organic search', (origin, platform) => {
      const result = classifySource(context({ referrerOrigin: origin }));

      expect(result.sourceType).toBe('organic_search');
      expect(result.sourcePlatform).toBe(platform);
      expect(result.confidence).toBe('derived');
    });

    it('does NOT treat a lookalike host as a search engine', () => {
      // `notgoogle.com` must not match `google.com`. Suffix matching without
      // the dot boundary is how that happens.
      const result = classifySource(context({ referrerOrigin: 'https://notgoogle.com' }));
      expect(result.sourceType).toBe('referral');
    });

    it('does NOT treat a site with "search" in its name as a search engine', () => {
      // `searchenginejournal.com` and `researchgate.net` are referrals.
      expect(
        classifySource(context({ referrerOrigin: 'https://www.searchenginejournal.com' }))
          .sourceType,
      ).toBe('referral');
    });

    it('matches a subdomain of a known engine', () => {
      expect(
        classifySource(context({ referrerOrigin: 'https://news.google.com' })).sourceType,
      ).toBe('organic_search');
    });
  });

  describe('⚠️ the search query is NEVER fabricated', () => {
    it('has no way to return a search query at all', () => {
      // The return type does not include one. Stated as a test because the
      // temptation to "just add it" is exactly what this guards against.
      const result = classifySource(
        context({
          referrerOrigin: 'https://www.google.com',
          utmTerm: 'emergency plumber melbourne',
        }),
      );

      expect(result).not.toHaveProperty('searchQuery');
    });

    it('does not promote utm_term to a keyword', () => {
      // `utm_term` is the MARKETER'S BID KEYWORD, not the visitor's search.
      // They differ constantly — broad match exists precisely because they do.
      const result = classifySource(context({ utmTerm: 'plumber', utmMedium: 'cpc' }));

      expect(JSON.stringify(result)).not.toContain('plumber');
    });

    it('does not infer a keyword from a Google referrer', () => {
      const result = classifySource(context({ referrerOrigin: 'https://www.google.com' }));

      // We know they came from Google. We do NOT know what they searched, and
      // the rationale says only what is true.
      expect(result.rationale).toMatch(/referred by google\.com/i);
      expect(result.rationale).not.toMatch(/search(ed| term| query) for/i);
    });
  });

  describe('the honest unknown', () => {
    it('classifies no referrer and no campaign as inferred direct', () => {
      const result = classifySource(context({}));

      expect(result.sourceType).toBe('direct');
      // `inferred`, not `derived`: this bucket contains typed URLs, bookmarks,
      // AND every referrer the browser withheld. Calling it "direct traffic"
      // with confidence is the most common attribution lie in the industry.
      expect(result.confidence).toBe('inferred');
      expect(result.rationale).toMatch(
        /may be a direct visit, or a referrer the browser withheld/i,
      );
    });

    it('classifies a campaign tag with no referrer as unknown, not direct', () => {
      // A QR code or a print ad. We know a campaign was involved and cannot
      // say which channel — `unknown` is the truthful answer.
      const result = classifySource(context({ utmCampaign: 'spring-flyer' }));

      expect(result.sourceType).toBe('unknown');
      expect(result.confidence).toBe('derived');
    });
  });

  describe('a browser cannot state its own provenance', () => {
    it('ignores anything resembling a claimed source in the context', () => {
      // The submission schema has no `sourceType`, `confidence` or
      // `searchQuery` field. Even if a caller sends them, they are stripped
      // before reaching here — and this asserts the classifier does not read
      // them even if they somehow survived.
      const hostile = {
        sourceType: 'organic_search',
        confidence: 'declared',
        searchQuery: 'best plumber melbourne',
      } as unknown as SubmissionContext;

      const result = classifySource(hostile);

      expect(result.sourceType).toBe('direct');
      expect(result.confidence).toBe('inferred');
    });
  });

  it('always returns a rationale an operator can read', () => {
    // Every acquisition shows why it was classified as it was. A source with
    // no explanation is a number nobody can check.
    const cases: SubmissionContext[] = [
      {},
      { gclid: 'x' },
      { fbclid: 'x' },
      { utmMedium: 'cpc' },
      { utmMedium: 'email' },
      { referrerOrigin: 'https://www.google.com' },
      { referrerOrigin: 'https://www.facebook.com' },
      { referrerOrigin: 'https://someblog.test' },
      { utmCampaign: 'flyer' },
    ];

    for (const input of cases) {
      const { rationale } = classifySource(input);
      expect(rationale.length).toBeGreaterThan(10);
      expect(rationale.endsWith('.')).toBe(true);
    }
  });
});
