/**
 * Crawl data — what Growth OS learned by fetching a customer's website.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Four tables, each answering a different question:
 *
 *   crawls           one execution. "What happened when we crawled on Tuesday?"
 *   crawl_frontier   the work list. "What did we find, and what did we do with it?"
 *   crawl_pages      one URL's facts. "What does /about say about itself?"
 *   crawl_links      the graph edge. "What links to /about, and with what text?"
 *
 * ⚠️ FACTS, NOT FINDINGS.
 * `title` is stored; "missing title, severity high" is not. Stage 5 reads these
 * rows and produces findings from them, which is what makes changing our mind
 * about severity a re-evaluation rather than a re-crawl of every customer's
 * website. Nothing in this file carries a score.
 *
 * ⚠️ NO RAW HTML.
 * Not in any column, and not compressed either (ADR-0034). A crawl of a
 * 500-page site would archive every word a business published — including the
 * customer testimonials, staff photos' alt text and the names on the team page
 * — in a store outside erasure's model. The extracted facts are bounded, and
 * the page is re-fetchable, which is the whole point of a URL.
 *
 * @see docs/decisions/ADR-0034-crawl-storage-model.md
 * @see docs/architecture/crawler-architecture.md
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  CRAWL_FAILURE_CATEGORIES,
  CRAWL_STATUSES,
  CRAWL_TRIGGERS,
  FRONTIER_STATES,
  INDEXABILITY_STATES,
  LINK_SCOPES,
  PAGE_FETCH_OUTCOMES,
  ROBOTS_OUTCOMES,
  SITEMAP_OUTCOMES,
  SKIP_REASONS,
} from '@growth-os/contracts';
import { users } from './identity';
import { sites } from './sites';
import { workspaces } from './tenancy';

export const crawlStatusEnum = pgEnum('crawl_status', CRAWL_STATUSES);
export const crawlTriggerEnum = pgEnum('crawl_trigger', CRAWL_TRIGGERS);
export const robotsOutcomeEnum = pgEnum('robots_outcome', ROBOTS_OUTCOMES);
export const sitemapOutcomeEnum = pgEnum('sitemap_outcome', SITEMAP_OUTCOMES);
export const frontierStateEnum = pgEnum('frontier_state', FRONTIER_STATES);
export const skipReasonEnum = pgEnum('crawl_skip_reason', SKIP_REASONS);
export const pageFetchOutcomeEnum = pgEnum('page_fetch_outcome', PAGE_FETCH_OUTCOMES);
export const crawlFailureEnum = pgEnum('crawl_failure_category', CRAWL_FAILURE_CATEGORIES);
export const indexabilityEnum = pgEnum('indexability_state', INDEXABILITY_STATES);
export const linkScopeEnum = pgEnum('link_scope', LINK_SCOPES);

// ---------------------------------------------------------------------------
// crawls
// ---------------------------------------------------------------------------

/**
 * One crawl execution.
 *
 * ⚠️ HISTORY IS THE POINT. A crawl never overwrites its predecessor, because
 * "what changed between Tuesday and Thursday?" is the question an SEO product
 * exists to answer, and a single mutable "latest crawl" row cannot answer it.
 * Retention is a decided rule later; keeping one row per run is what makes such
 * a rule possible at all.
 */
export const crawls = pgTable(
  'crawls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),

    status: crawlStatusEnum('status').notNull().default('queued'),
    trigger: crawlTriggerEnum('trigger').notNull(),

    /**
     * The origin as it was at the moment the crawl started.
     *
     * Denormalised deliberately: a site can be edited, and a crawl of
     * `http://example.test` must not later read as a crawl of
     * `https://www.example.test` because someone corrected the record. A crawl
     * is a historical measurement and its subject is part of the measurement.
     */
    origin: text('origin').notNull(),

    /** The ceiling this run was given. Stored, so an old run stays explicable. */
    pageLimit: integer('page_limit').notNull(),
    maxDepth: smallint('max_depth').notNull(),

    robotsOutcome: robotsOutcomeEnum('robots_outcome'),
    sitemapOutcome: sitemapOutcomeEnum('sitemap_outcome'),
    /** How many URLs the sitemaps contributed, before scope and dedupe. */
    sitemapUrlCount: integer('sitemap_url_count').notNull().default(0),

    pagesDiscovered: integer('pages_discovered').notNull().default(0),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    pagesFailed: integer('pages_failed').notNull().default(0),
    pagesSkipped: integer('pages_skipped').notNull().default(0),

    /** Total bytes accepted from the network. An operational cost signal. */
    bytesDownloaded: integer('bytes_downloaded').notNull().default(0),

    /**
     * A TYPED CATEGORY, never a stack trace.
     *
     * This value is shown to a customer. `connect ETIMEDOUT 93.184.216.34:443`
     * is neither something they can act on nor something they should be shown.
     */
    failureCategory: crawlFailureEnum('failure_category'),
    /** One short sentence, safe for an operator. Never a URL with a query. */
    failureDetail: text('failure_detail'),

    /**
     * ⚠️ NULL FOR A SCHEDULED CRAWL, and that is the honest value.
     *
     * `actorUserId()` throws on a system context precisely so that nothing
     * writes a fabricated user id here (ADR-0025). "Who started this?" has two
     * true answers — a person, or the system — and `trigger` says which.
     */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Set when a cancellation is requested; the worker stops at its next check. */
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  },
  (table) => [
    // The site detail page's only query: this site's crawls, newest first.
    index('crawls_site_created_idx').on(table.workspaceId, table.siteId, table.createdAt),
    // The worker's query: crawls that still need work, oldest first.
    index('crawls_status_idx').on(table.status, table.createdAt),
  ],
);

export type CrawlRow = typeof crawls.$inferSelect;

// ---------------------------------------------------------------------------
// site_pages
// ---------------------------------------------------------------------------

/**
 * A page's DURABLE IDENTITY, independent of any crawl.
 *
 * ⚠️ THE SEPARATION OF IDENTITY FROM FACTS IS THE POINT OF THIS TABLE, AND IT
 * IS THE THING A FUTURE CONTRIBUTOR WILL BE TEMPTED TO COLLAPSE.
 *
 * `/about` is one page. It has been crawled eleven times, and on the seventh
 * crawl its title changed. Those are two different kinds of statement:
 *
 *   - "there is a page at /about, first seen in March, still there" — IDENTITY,
 *     one row, here.
 *   - "on 14 August its title was 'About us' and it returned 200" —
 *     OBSERVATION, one row per crawl, in `crawl_pages`.
 *
 * Putting the title on this row would make the question "when did the title
 * change?" unanswerable, because there would only ever be the latest value.
 * Change detection is a DIFF BETWEEN OBSERVATIONS; it needs both an anchor that
 * survives every crawl and a history that does not collapse.
 *
 * ⚠️ SO THIS TABLE CARRIES NO FACTS. Not the title, not the status code, not
 * the word count — not even "the last known title", however convenient a join
 * it would save. The moment one fact lands here, the next one is an argument
 * rather than a rule, and the table becomes a mutable summary that silently
 * disagrees with the observations underneath it.
 *
 * Adding this later would have been a migration plus a backfill over every
 * customer's crawl history, which is why it exists before the first row does.
 *
 * @see docs/decisions/ADR-0034-crawl-storage-model.md
 */
export const sitePages = pgTable(
  'site_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),

    /** The canonical crawl identity. One definition, `normaliseUrl`. */
    normalisedUrl: text('normalised_url').notNull(),

    // -- Lifecycle. Not facts about the page; facts about our knowledge of it.
    /** The first crawl that ever saw this URL. */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** The most recent crawl that saw it. A gap is how a page goes missing. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * ⚠️ THE DURABLE KEY. One row per URL per site, for all time.
     *
     * `crawl_pages` is unique on `(crawl_id, normalised_url)` — one observation
     * per crawl. This is unique on `(site_id, normalised_url)` — one page, ever.
     * Two constraints, two different statements, and neither replaces the other.
     */
    uniqueIndex('site_pages_site_url_unique').on(table.siteId, table.normalisedUrl),
    index('site_pages_workspace_idx').on(table.workspaceId, table.siteId, table.lastSeenAt),
  ],
);

export type SitePageRow = typeof sitePages.$inferSelect;

// ---------------------------------------------------------------------------
// crawl_frontier
// ---------------------------------------------------------------------------

/**
 * The work list — every URL this crawl knows about.
 *
 * ⚠️ IN THE DATABASE, NOT IN A `Set` IN MEMORY.
 *
 * A worker that dies mid-crawl must not forget what it had discovered. The
 * in-memory alternative costs a customer's server a complete re-fetch of every
 * page it already served, which is both slower and ruder than remembering.
 *
 * ⚠️ IT RECORDS URLS THAT WERE NOT FETCHED, WITH THE REASON.
 * "We found 900 URLs and fetched 500" is a different fact from "the site has
 * 500 pages", and a crawler that silently dropped the difference would report
 * the second while meaning the first.
 */
export const crawlFrontier = pgTable(
  'crawl_frontier',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    crawlId: uuid('crawl_id')
      .notNull()
      .references(() => crawls.id, { onDelete: 'cascade' }),

    /** The canonical crawl identity. See `normaliseUrl` — one definition. */
    normalisedUrl: text('normalised_url').notNull(),

    state: frontierStateEnum('state').notNull().default('discovered'),
    skipReason: skipReasonEnum('skip_reason'),

    /** Distance from the seed, in path segments plus link hops. */
    depth: smallint('depth').notNull().default(0),

    /**
     * How this URL was found: a link, a sitemap entry, a redirect target, or
     * the seed. Kept because "why did you crawl that?" is a real question when
     * a page appears that the operator did not expect.
     */
    // Drizzle needs the explicit `AnyPgColumn` annotation on a self-reference,
    // or the table's type refers to itself while it is still being inferred.
    discoveredFrom: uuid('discovered_from').references((): AnyPgColumn => crawlFrontier.id, {
      onDelete: 'set null',
    }),
    discoverySource: text('discovery_source').notNull().default('link'),

    attempts: smallint('attempts').notNull().default(0),
    /** Set when claimed; a stalled claim older than the reclaim window resets. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * ⚠️ THE DEDUPLICATION GUARANTEE, ENFORCED BY THE DATABASE.
     *
     * Two workers discovering the same URL at the same moment is not a race to
     * be avoided in application code — it is the normal case on a site where
     * every page links to `/contact`. The unique index makes the second insert
     * a no-op instead of a duplicate row.
     */
    uniqueIndex('crawl_frontier_crawl_url_unique').on(table.crawlId, table.normalisedUrl),
    // The claim query: this crawl's queued work.
    index('crawl_frontier_claim_idx').on(table.crawlId, table.state, table.createdAt),
  ],
);

export type CrawlFrontierRow = typeof crawlFrontier.$inferSelect;

// ---------------------------------------------------------------------------
// crawl_pages
// ---------------------------------------------------------------------------

/**
 * One URL's facts, as of one crawl.
 *
 * Every column is something the page said about itself. None of them is a
 * judgement about whether it should have.
 */
export const crawlPages = pgTable(
  'crawl_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    crawlId: uuid('crawl_id')
      .notNull()
      .references(() => crawls.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /**
     * The durable page this observation is OF.
     *
     * Nullable only so a page that failed before it could be identified still
     * records the attempt. Every successful fetch attaches to one.
     */
    sitePageId: uuid('site_page_id').references(() => sitePages.id, { onDelete: 'cascade' }),

    normalisedUrl: text('normalised_url').notNull(),
    depth: smallint('depth').notNull().default(0),

    outcome: pageFetchOutcomeEnum('outcome').notNull(),
    failureCategory: crawlFailureEnum('failure_category'),

    // -- Response facts ----------------------------------------------------
    httpStatus: smallint('http_status'),
    contentType: text('content_type'),
    contentLength: integer('content_length'),
    fetchDurationMs: integer('fetch_duration_ms'),
    /** The final URL after redirects, when it differs. */
    finalUrl: text('final_url'),
    redirectCount: smallint('redirect_count').notNull().default(0),

    // -- Conditional-request facts, for the NEXT crawl ---------------------
    etag: text('etag'),
    lastModified: text('last_modified'),
    /**
     * A stable hash of the extracted TEXT, not the raw HTML.
     *
     * Hashing the HTML would report a change every time a CMS re-ordered an
     * attribute or stamped a build id into a comment. Hashing the text answers
     * the question an operator actually asks: did the CONTENT change?
     */
    contentHash: text('content_hash'),

    // -- Extracted facts ---------------------------------------------------
    title: text('title'),
    metaDescription: text('meta_description'),
    canonicalUrl: text('canonical_url'),
    robotsMeta: text('robots_meta'),
    xRobotsTag: text('x_robots_tag'),
    htmlLang: text('html_lang'),

    h1Count: smallint('h1_count'),
    h1Text: text('h1_text'),
    h2Count: smallint('h2_count'),
    wordCount: integer('word_count'),

    internalLinkCount: smallint('internal_link_count'),
    externalLinkCount: smallint('external_link_count'),
    imageCount: smallint('image_count'),
    imagesMissingAltCount: smallint('images_missing_alt_count'),

    /** The `@type` values found in ld+json. Presence, not validation. */
    structuredDataTypes: jsonb('structured_data_types').$type<string[]>(),
    hreflangValues: jsonb('hreflang_values').$type<string[]>(),
    hasOpenGraph: boolean('has_open_graph').notNull().default(false),
    hasViewport: boolean('has_viewport').notNull().default(false),

    /** Derived from the facts above, and from robots. Still a fact. */
    indexability: indexabilityEnum('indexability'),

    /** True when the extractor hit a cap and stopped early. */
    extractionTruncated: boolean('extraction_truncated').notNull().default(false),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * ⚠️ ONE ROW PER URL PER CRAWL — the retry-safety guarantee.
     *
     * The queue is at-least-once, so a page job WILL sometimes run twice. Two
     * rows for one URL would double every count on the summary. Writes go
     * through this constraint with an upsert, which makes a retry idempotent by
     * construction rather than by a check that could be forgotten.
     *
     * Retries are execution history and live on the frontier row's `attempts`,
     * not as duplicate page identities.
     */
    uniqueIndex('crawl_pages_crawl_url_unique').on(table.crawlId, table.normalisedUrl),
    // "Show me this crawl's pages" and "how has /about changed over time?"
    index('crawl_pages_crawl_idx').on(table.workspaceId, table.crawlId, table.normalisedUrl),
    // Change detection: this page's observations, newest first.
    index('crawl_pages_site_page_idx').on(table.sitePageId, table.fetchedAt),
    index('crawl_pages_site_url_idx').on(table.siteId, table.normalisedUrl, table.fetchedAt),
    // Stage 5's queries: "which pages are 404?", "which are noindex?"
    index('crawl_pages_status_idx').on(table.crawlId, table.httpStatus),
  ],
);

export type CrawlPageRow = typeof crawlPages.$inferSelect;

// ---------------------------------------------------------------------------
// crawl_links
// ---------------------------------------------------------------------------

/**
 * One edge of the internal link graph.
 *
 * ⚠️ ENOUGH TO COMPUTE PAGERANK LATER, WITHOUT COMPUTING IT NOW.
 * Stage 5 needs "which pages are orphaned?" and "which have very few internal
 * links?"; a later content agent will want link position and anchor
 * distribution. Storing the edges answers all of those from data; storing a
 * precomputed score answers only the question we thought of today.
 *
 * ⚠️ ANCHOR TEXT IS ARBITRARY PUBLIC CONTENT. Capped, plain text, no markup.
 */
export const crawlLinks = pgTable(
  'crawl_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    crawlId: uuid('crawl_id')
      .notNull()
      .references(() => crawls.id, { onDelete: 'cascade' }),

    sourcePageId: uuid('source_page_id')
      .notNull()
      .references(() => crawlPages.id, { onDelete: 'cascade' }),
    /** The link's destination, normalised. Not a foreign key: it may be off-site,
     *  and an internal target may not have been fetched yet — or at all. */
    targetUrl: text('target_url').notNull(),
    scope: linkScopeEnum('scope').notNull(),

    /** Plain text, capped. Never markup. */
    anchorText: text('anchor_text'),
    isNofollow: boolean('is_nofollow').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('crawl_links_source_idx').on(table.crawlId, table.sourcePageId),
    // "What links here?" — the orphan and internal-link-count query.
    index('crawl_links_target_idx').on(table.crawlId, table.targetUrl),
  ],
);

export type CrawlLinkRow = typeof crawlLinks.$inferSelect;
