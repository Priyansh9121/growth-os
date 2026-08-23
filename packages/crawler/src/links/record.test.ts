/**
 * Which discovered links become frontier candidates.
 *
 * ⚠️ A UNIT TEST ON PURPOSE, not part of `record.integration.test.ts`.
 * `linkCandidates` is pure, and the integration project is excluded from the
 * unit tier — so living beside `recordLinks` would mean these assertions
 * silently do not run for anyone without a database. AGENTS.md §1: prefer the
 * cheap gate.
 *
 * @see docs/decisions/ADR-0069-discovered-links-become-frontier-candidates.md
 */

import { describe, expect, it } from 'vitest';
import { linkCandidates } from './record';
import type { ExtractedLink } from './extract';

const ORIGIN = 'https://example.test';

const link = (overrides: Partial<ExtractedLink> = {}): ExtractedLink => ({
  targetUrl: `${ORIGIN}/about`,
  scope: 'internal',
  anchorText: 'About us',
  isNofollow: false,
  ...overrides,
});

describe('linkCandidates', () => {
  const of = (...links: ExtractedLink[]) => linkCandidates(links, 3);

  it('offers internal links only', () => {
    const candidates = of(
      link({ targetUrl: `${ORIGIN}/a`, scope: 'internal' }),
      link({ targetUrl: 'https://other.test/b', scope: 'external' }),
      link({ targetUrl: 'https://blog.example.test/c', scope: 'other_subdomain' }),
    );

    expect(candidates.map((c) => c.url)).toEqual([`${ORIGIN}/a`]);
  });

  it('⚠️ offers a nofollow internal link — nofollow is not an admission rule', () => {
    // It tells a search engine not to pass weight. It does not tell a site's
    // own auditor not to look (ADR-0069, decision 2).
    const candidates = of(link({ targetUrl: `${ORIGIN}/legacy`, isNofollow: true }));
    expect(candidates.map((c) => c.url)).toEqual([`${ORIGIN}/legacy`]);
  });

  it('stamps the caller\u2019s depth and marks the source as a link', () => {
    // `decideEnqueue` uses `candidate.depth` verbatim, so the caller passing
    // `source.depth + 1` is what makes a link a hop.
    const [candidate] = of(link());
    expect(candidate?.depth).toBe(3);
    expect(candidate?.source).toBe('link');
  });

  it('returns nothing for a page whose links are all outbound', () => {
    expect(of(link({ scope: 'external' }), link({ scope: 'other_subdomain' }))).toEqual([]);
  });

  it('preserves document order among the internal links', () => {
    const candidates = of(
      link({ targetUrl: `${ORIGIN}/one` }),
      link({ targetUrl: 'https://other.test/skip', scope: 'external' }),
      link({ targetUrl: `${ORIGIN}/two` }),
    );

    expect(candidates.map((c) => c.url)).toEqual([`${ORIGIN}/one`, `${ORIGIN}/two`]);
  });
});
