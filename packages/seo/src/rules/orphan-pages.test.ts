/**
 * The pure half of the orphan rule: what an audit becomes as rows.
 *
 * WHY THIS TIER EXISTS AT ALL when the rule is mostly a query. The evidence
 * shape is the part a future rule author copies, and it is the part
 * `seo_findings_evidence_is_a_bounded_object` refuses to store wrongly. A test
 * that only ran for someone with PostgreSQL would leave the shape unasserted in
 * the cheap gate everybody runs — the tier mistake dev log 0055 caught in
 * `linkCandidates`.
 *
 * @see docs/decisions/ADR-0072-the-orphan-page-rule.md
 */

import { describe, expect, it } from 'vitest';
import { orphanFindings, RETRIEVED_OUTCOMES, type OrphanAudit } from './orphan-pages';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const CRAWL = '00000000-0000-4000-8000-000000000002';
const PAGE_A = '00000000-0000-4000-8000-00000000000a';
const PAGE_B = '00000000-0000-4000-8000-00000000000b';

const audit = (overrides: Partial<OrphanAudit> = {}): OrphanAudit => ({
  pagesConsidered: 42,
  orphans: [{ sitePageId: PAGE_A, normalisedUrl: 'https://example.test/hidden' }],
  ...overrides,
});

describe('orphanFindings', () => {
  it('carries the deciding fact and nothing else', () => {
    const [row] = orphanFindings(WORKSPACE, CRAWL, audit());

    expect(row).toEqual({
      workspaceId: WORKSPACE,
      crawlId: CRAWL,
      sitePageId: PAGE_A,
      rule: 'orphan_page',
      evidence: { internalInboundLinks: 0, pagesConsidered: 42 },
    });
  });

  it('⚠️ has no severity, priority or message — that is the stage boundary', () => {
    // AGENTS.md §5: the crawler acquires facts, the audit layer interprets them
    // into findings, and NEITHER assigns a severity. If a future change adds one
    // to the row, this fails and the ADR has to be revisited rather than the
    // column quietly appearing.
    const [row] = orphanFindings(WORKSPACE, CRAWL, audit());

    expect(Object.keys(row!).sort()).toEqual([
      'crawlId',
      'evidence',
      'rule',
      'sitePageId',
      'workspaceId',
    ]);
    expect(Object.keys(row!.evidence as object).sort()).toEqual([
      'internalInboundLinks',
      'pagesConsidered',
    ]);
  });

  it('⚠️ the denominator is the pages RETRIEVED, not the orphans found', () => {
    // The brief said "out of N pages crawled". Two orphans out of 42 retrieved
    // pages is a very different statement from two out of two, and reusing the
    // orphan count as the population would produce the second one every time.
    const rows = orphanFindings(
      WORKSPACE,
      CRAWL,
      audit({
        pagesConsidered: 42,
        orphans: [
          { sitePageId: PAGE_A, normalisedUrl: 'https://example.test/hidden' },
          { sitePageId: PAGE_B, normalisedUrl: 'https://example.test/legacy' },
        ],
      }),
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.evidence).toEqual({ internalInboundLinks: 0, pagesConsidered: 42 });
    }
  });

  it('every finding names its own page', () => {
    const rows = orphanFindings(
      WORKSPACE,
      CRAWL,
      audit({
        orphans: [
          { sitePageId: PAGE_A, normalisedUrl: 'https://example.test/hidden' },
          { sitePageId: PAGE_B, normalisedUrl: 'https://example.test/legacy' },
        ],
      }),
    );

    expect(rows.map((row) => row.sitePageId)).toEqual([PAGE_A, PAGE_B]);
  });

  it('a crawl with no orphans produces no rows at all', () => {
    // The per-crawl lifetime (ADR-0070) depends on this: a page that stopped
    // being orphaned is expressed by the ABSENCE of a row, so "no orphans" must
    // mean "write nothing" and never "write a row saying zero".
    expect(orphanFindings(WORKSPACE, CRAWL, audit({ orphans: [] }))).toEqual([]);
  });
});

describe('RETRIEVED_OUTCOMES', () => {
  it('⚠️ is the outcomes that mean a page was READ, not every row in crawl_pages', () => {
    // The brief's denominator was "pages crawled". `crawl_pages` also holds
    // http_4xx, http_5xx, blocked, redirected and failed — attempts, not pages.
    // A 404 states no links and cannot be orphaned; counting it would inflate
    // the denominator and emit a finding for every broken URL a site links to.
    expect([...RETRIEVED_OUTCOMES]).toEqual(['fetched', 'unchanged']);
  });
});
