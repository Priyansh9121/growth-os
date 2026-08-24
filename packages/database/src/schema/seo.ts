/**
 * Findings — what the audit layer concluded from one crawl's facts.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * `crawl_pages` and `crawl_links` record what a website said. This records what
 * a rule DECIDED after reading them. That is the stage boundary AGENTS.md §5
 * draws, and it is the reason this table is in its own file rather than in
 * `crawl.ts`: a schema file whose header says "nothing here carries a score"
 * cannot also be where the interpretations live.
 *
 * ⚠️ A FINDING BELONGS TO A CRAWL, NOT TO A PAGE.
 * ADR-0034 gives the test: "if a crawl could observe it differently next time,
 * it is a fact and it belongs to the observation". A finding is derived
 * ENTIRELY from one crawl's observations, so it is scoped exactly as
 * `crawl_pages` is — one row per crawl, never overwritten.
 *
 * The consequence is the point. A page that stops being orphaned does not need
 * anything DELETED: the next crawl simply produces no `orphan_page` row for it,
 * and "the finding closed between crawl 12 and crawl 13" is readable from the
 * two crawls' rows. A durable finding with a `resolved_at` column would need
 * something to notice the fix and write to it, and would be wrong whenever that
 * something did not run.
 *
 * ⚠️ THE ROW CARRIES THE DECIDING FACT AND NOTHING ELSE.
 * No severity, no priority, no recommendation, no sentence of English. "0
 * internal inbound links, out of 42 pages retrieved" is what was measured.
 * "This page needs more internal links" is copy addressed to a reader, and the
 * layer that stores measurements is not the layer that chooses a reader.
 *
 * @see docs/decisions/ADR-0070-findings-belong-to-a-crawl.md
 * @see docs/decisions/ADR-0034-crawl-storage-model.md
 */

import { index, jsonb, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { SEO_FINDING_RULES } from '@growth-os/contracts';
import { crawls, sitePages } from './crawl';
import { workspaces } from './tenancy';

export const seoFindingRuleEnum = pgEnum('seo_finding_rule', SEO_FINDING_RULES);

export const seoFindings = pgTable(
  'seo_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** The crawl whose facts decided this. The finding's whole lifetime. */
    crawlId: uuid('crawl_id')
      .notNull()
      .references(() => crawls.id, { onDelete: 'cascade' }),

    /**
     * The DURABLE page this is about — `site_pages`, not `crawl_pages`.
     *
     * ⚠️ AND THAT IS WHAT MAKES A FINDING TRACKABLE ACROSS CRAWLS. Two crawls'
     * `orphan_page` rows for the same page share this id, so "still orphaned in
     * March" is a query rather than a string comparison on a URL. Pointing at
     * the observation instead would scope the finding's SUBJECT to one crawl as
     * well as its lifetime, and there would be nothing to compare.
     *
     * NOT NULL, unlike `crawl_pages.site_page_id`. A fetch that failed before
     * the URL was resolved is still evidence and gets an observation row; a
     * finding about no particular page is not a finding.
     */
    sitePageId: uuid('site_page_id')
      .notNull()
      .references(() => sitePages.id, { onDelete: 'cascade' }),

    rule: seoFindingRuleEnum('rule').notNull(),

    /**
     * The measurement that decided the rule. Rule-shaped, so `jsonb`.
     *
     * ⚠️ NOT A FREE-FORM BAG. The database refuses anything that is not a
     * non-empty JSON object under 4 KB, because a finding whose evidence is
     * `null`, `{}` or a megabyte of prose is not a measurement.
     *
     * ⚠️ AND NOT SHARED TYPED COLUMNS EITHER. `observed` / `population` would
     * fit `orphan_page` and be a lie for the first rule that decides on a
     * boolean or a string. Inventing a common shape from a sample size of one
     * is the over-building AGENTS.md §3 forbids; the honest statement today is
     * "the deciding facts differ per rule".
     *
     * For `orphan_page`: `{ internalInboundLinks, pagesConsidered }`.
     */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),

    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * ⚠️ ONE FINDING PER RULE PER PAGE PER CRAWL — and this is the ROW BOUND.
     *
     * AGENTS.md §5 puts limits in the database. A per-crawl row CEILING cannot
     * be one: a CHECK constraint sees a single row and cannot count a table.
     * This does the job structurally instead — the rule can write at most one
     * row per retrieved page, `crawl_pages` holds at most one row per URL per
     * crawl, and `crawls_budget_is_bounded` caps `page_limit` at 10,000. The
     * ceiling therefore exists, is enforced, and needs no number of its own.
     *
     * It is also the retry guarantee, exactly as
     * `crawl_pages_crawl_url_unique` is: re-auditing a crawl must not double
     * every finding on it.
     */
    uniqueIndex('seo_findings_crawl_page_rule_unique').on(
      table.crawlId,
      table.sitePageId,
      table.rule,
    ),
    // "What did this crawl find?" — the audit's own read.
    index('seo_findings_crawl_idx').on(table.workspaceId, table.crawlId, table.rule),
    // "Has this page been orphaned before?" — the across-crawls comparison.
    index('seo_findings_page_idx').on(table.sitePageId, table.rule, table.detectedAt),
  ],
);

export type SeoFindingRow = typeof seoFindings.$inferSelect;
export type NewSeoFindingRow = typeof seoFindings.$inferInsert;
