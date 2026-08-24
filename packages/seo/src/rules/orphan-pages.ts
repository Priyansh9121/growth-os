/**
 * `orphan_page` — pages a crawl retrieved that nothing on the site links to.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * This is the first code in the repository on the FINDINGS side of AGENTS.md
 * §5's stage boundary. `crawl_pages` and `crawl_links` say what a website said;
 * this decides something about it and writes the decision down.
 *
 * ⚠️ IT STILL RECORDS A MEASUREMENT, NOT A JUDGEMENT.
 * The finding is "0 internal inbound links, out of 42 pages retrieved". It is
 * not "this page needs more internal links", not a severity and not a priority.
 * A rule identifier says which question was asked; what the answer is worth is a
 * product decision and a UI's copy.
 *
 * ⚠️ NO URL LOGIC LIVES HERE, AND THAT IS THE POINT (§5, URL identity is
 * singular). The join is a plain text equality between `crawl_links.target_url`
 * and `crawl_pages.normalised_url`, and it is sound precisely because both sides
 * already went through the ONE `normaliseUrl` in the crawler — `extract.ts:330`
 * normalises every `href` before it is ever recorded. Likewise `scope` is the
 * verdict of the one `classifyScope`, read from the column rather than
 * recomputed. A second normaliser or a second scope rule here would be the
 * defect ADR-0066 and dev log 0054 were both written about.
 *
 * @see docs/decisions/ADR-0072-the-orphan-page-rule.md
 * @see docs/decisions/ADR-0070-findings-belong-to-a-crawl.md
 */

import { and, eq, exists, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { schemaTables, type TenantTransaction } from '@growth-os/database';
import type { PageFetchOutcome } from '@growth-os/contracts';

const { crawlLinks, crawlPages, seoFindings } = schemaTables;

/**
 * The outcomes that mean a page was actually READ.
 *
 * ⚠️ "RETRIEVED", NOT "CRAWLED" — AND THE BRIEF SAID CRAWLED.
 * `crawl_pages` holds a row for every attempt, including `http_4xx`,
 * `http_5xx`, `blocked` and `failed`. Those are facts worth recording and they
 * are not pages: a 404 has no content, states no links, and cannot be orphaned.
 * Including them would inflate the denominator with attempts nobody read and
 * would emit an `orphan_page` finding for every broken URL a site links to.
 *
 * `unchanged` is a 304 — the page exists and its facts were carried forward
 * from the previous crawl, so it is retrieved in every sense that matters here.
 */
export const RETRIEVED_OUTCOMES = [
  'fetched',
  'unchanged',
] as const satisfies readonly PageFetchOutcome[];

/**
 * Rows per INSERT statement.
 *
 * ⚠️ NOT A PERFORMANCE TUNING, and the number was measured rather than copied.
 * PostgreSQL accepts at most 65535 bound parameters in one statement, and each
 * finding binds 5. `crawls_budget_is_bounded` caps `page_limit` at 10,000, and
 * the worst case — every retrieved page orphaned — is therefore 50,000
 * parameters: under the ceiling today, and over it the moment a sixth and
 * seventh column appear on the row. Chunking makes that coupling not exist
 * rather than documenting it, exactly as `recordLinks` does.
 */
const INSERT_CHUNK = 500;

/** A retrieved page with no internal inbound link, and the durable id for it. */
export interface OrphanPage {
  /** `site_pages.id` — the DURABLE page, which is what a finding points at. */
  readonly sitePageId: string;
  readonly normalisedUrl: string;
}

export interface OrphanAudit {
  /**
   * The denominator: how many pages this crawl actually retrieved.
   *
   * It is the population the rule examined in BOTH roles — every one of these
   * pages was a candidate to be orphaned, and every one of them was a possible
   * source of a link that would prove another one is not.
   */
  readonly pagesConsidered: number;
  readonly orphans: readonly OrphanPage[];
}

export interface OrphanAuditResult {
  readonly pagesConsidered: number;
  readonly orphansFound: number;
  /**
   * Rows this call actually inserted.
   *
   * ⚠️ DIFFERENT FROM `orphansFound` ON A RE-AUDIT, and that is the point. The
   * write is `ON CONFLICT DO NOTHING ... RETURNING`, so a second audit of the
   * same crawl finds the same orphans and writes zero rows. Reporting the two
   * separately makes idempotency observable instead of merely claimed — the
   * same signal ADR-0067 established for `markFetched`.
   */
  readonly findingsWritten: number;
}

/**
 * Which retrieved pages have no internal inbound link, and how many were
 * retrieved in total.
 *
 * ⚠️ ONE QUERY, so the numerator and the denominator come from one snapshot. A
 * separate `COUNT(*)` would be cheaper and would let the population and the
 * orphan set disagree if anything wrote between them.
 *
 * ⚠️ SCOPED BY `crawl_id` ONLY. Tenant scoping is the caller's transaction and
 * the RLS policy on both tables, which is the convention every read in
 * `packages/crawler` follows. Adding a redundant `workspace_id` predicate here
 * would suggest the policy is not trusted, and the place to fix that would be
 * the policy.
 */
export async function findOrphanPages(
  tx: TenantTransaction,
  crawlId: string,
): Promise<OrphanAudit> {
  /**
   * ⚠️ `source_page_id <> crawl_pages.id` — A SELF-LINK IS NOT AN INBOUND LINK,
   * and this was not in the brief.
   *
   * Almost every page links to itself: a logo in the header, a "you are here"
   * breadcrumb, a canonical nav item. A page whose ONLY internal inbound link
   * comes from itself is still unreachable from the rest of the site, which is
   * the entire condition this rule exists to detect. Without this predicate the
   * rule would silently under-report exactly the pages it was written to find.
   *
   * The comparison is between `crawl_links.source_page_id` and
   * `crawl_pages.id` — both `crawl_pages` identities, per the column's own
   * foreign key. Comparing against `site_page_id` would be a different and
   * wrong question.
   */
  const hasInternalInboundLink = exists(
    tx
      .select({ one: sql`1` })
      .from(crawlLinks)
      .where(
        and(
          eq(crawlLinks.crawlId, crawlId),
          // The verdict of the one `classifyScope`, read rather than recomputed.
          eq(crawlLinks.scope, 'internal'),
          eq(crawlLinks.targetUrl, crawlPages.normalisedUrl),
          ne(crawlLinks.sourcePageId, crawlPages.id),
        ),
      ),
  );

  const rows = await tx
    .select({
      sitePageId: crawlPages.sitePageId,
      normalisedUrl: crawlPages.normalisedUrl,
      hasInternalInboundLink,
    })
    .from(crawlPages)
    .where(
      and(
        eq(crawlPages.crawlId, crawlId),
        inArray(crawlPages.outcome, [...RETRIEVED_OUTCOMES]),
        // `crawl_pages.site_page_id` is nullable and `seo_findings.site_page_id`
        // is not (ADR-0070). `markFetched` — the only writer — always sets it,
        // so this excludes nothing today; it is here so that if a second writer
        // ever does not, the rule drops the row rather than crashing on insert.
        isNotNull(crawlPages.sitePageId),
      ),
    );

  return {
    pagesConsidered: rows.length,
    orphans: rows
      .filter((row) => !row.hasInternalInboundLink)
      .map((row) => ({ sitePageId: row.sitePageId!, normalisedUrl: row.normalisedUrl })),
  };
}

/**
 * The rows an audit becomes. Pure, so the evidence shape is testable without a
 * database — and it is the shape `seo_findings_evidence_is_a_bounded_object`
 * refuses to store wrongly.
 */
export function orphanFindings(
  workspaceId: string,
  crawlId: string,
  audit: OrphanAudit,
): (typeof seoFindings.$inferInsert)[] {
  return audit.orphans.map((orphan) => ({
    workspaceId,
    crawlId,
    sitePageId: orphan.sitePageId,
    rule: 'orphan_page' as const,
    // ⚠️ `internalInboundLinks` IS LITERALLY ZERO, not a count that happens to
    // be zero. `findOrphanPages` returns only the pages with no inbound link,
    // so the value is a property of membership in that set. A rule that reports
    // "few inbound links" would need a real count and a threshold, and that is
    // a different rule with a different name.
    evidence: { internalInboundLinks: 0, pagesConsidered: audit.pagesConsidered },
  }));
}

/**
 * Audit one crawl for orphan pages and record what it found.
 *
 * Takes the caller's transaction, so the findings for a crawl land together or
 * not at all — a half-written audit would be indistinguishable from a crawl
 * with fewer orphans.
 */
export async function recordOrphanPages(
  tx: TenantTransaction,
  workspaceId: string,
  crawlId: string,
): Promise<OrphanAuditResult> {
  const audit = await findOrphanPages(tx, crawlId);
  const rows = orphanFindings(workspaceId, crawlId, audit);

  let findingsWritten = 0;
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const written = await tx
      .insert(seoFindings)
      .values(rows.slice(offset, offset + INSERT_CHUNK))
      // The row bound doubles as the retry guarantee (ADR-0070): re-auditing a
      // crawl must be idempotent, not a way to double every finding on it.
      .onConflictDoNothing({
        target: [seoFindings.crawlId, seoFindings.sitePageId, seoFindings.rule],
      })
      .returning({ id: seoFindings.id });
    findingsWritten += written.length;
  }

  return { pagesConsidered: audit.pagesConsidered, orphansFound: rows.length, findingsWritten };
}
