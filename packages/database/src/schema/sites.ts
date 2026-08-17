/**
 * Web properties — the websites a workspace owns.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single answer to "which website does this workspace own?", shared by
 * lead capture (allowed origins, attribution), the Stage 4 crawler, and Search
 * Console later. Built here, in the schema package, rather than inside
 * `@growth-os/crm`, because a website is not a customer record and the crawler
 * must not import the CRM to find one.
 *
 * A WORKSPACE HAS MANY SITES
 * Not `workspaces.website`. A plumbing business runs its main site and a
 * campaign microsite; an agency's client has a brand site and a booking
 * subdomain; a rebrand runs both for a year. One-website-per-workspace is the
 * kind of assumption that is free today and costs a migration plus a
 * data-quality exercise later.
 *
 * @see docs/decisions/ADR-0029-web-properties.md
 */

import {
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  SITE_STATUSES,
  SITE_VERIFICATION_METHODS,
  SITE_VERIFICATION_STATES,
} from '@growth-os/contracts';
import { users } from './identity';
import { workspaces } from './tenancy';

export const siteStatusEnum = pgEnum('site_status', SITE_STATUSES);
export const siteVerificationEnum = pgEnum('site_verification_state', SITE_VERIFICATION_STATES);
export const siteVerificationMethodEnum = pgEnum(
  'site_verification_method',
  SITE_VERIFICATION_METHODS,
);

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Human label. "Main site", "Spring campaign". */
    name: text('name').notNull(),

    /**
     * The canonical ORIGIN — scheme, host and port — not a bare domain.
     *
     * `https://www.abcplumbing.test`. Normalised: lowercased, default ports
     * stripped, path and query removed. `www.` is PRESERVED, because
     * `https://www.x.test` and `https://x.test` are genuinely different
     * origins to a browser and treating them as one would make an allowed-origin
     * check wrong in whichever direction we guessed.
     *
     * Stored as an origin rather than a domain because origins are what the
     * `Origin` header carries and what CSP matches; reconstructing one at every
     * comparison is how a scheme ends up wrong somewhere.
     */
    origin: text('origin').notNull(),

    status: siteStatusEnum('status').notNull().default('active'),

    /**
     * CONFIGURED IS NOT VERIFIED, and the distinction is in the schema so that
     * Stage 4 tightens a check rather than introducing a concept.
     *
     * Stage 3 needs only `unverified`: embedding a form on a site you do not
     * own harms only you, since the submissions land in your own CRM.
     * Crawling and Search Console are claims about ownership and will require
     * `verified`.
     */
    verificationState: siteVerificationEnum('verification_state').notNull().default('unverified'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    /**
     * The opaque proof an operator publishes on their own property.
     *
     * ⚠️ IT IS A PROOF, NOT A CREDENTIAL. Holding it grants nothing: it is
     * published in a customer's page source or in public DNS, and every
     * security property must hold with it fully visible. What it demonstrates
     * is control of a place only the owner can write to.
     *
     * 128 bits, hex, same shape and CHECK as a form's public key.
     */
    verificationToken: text('verification_token'),
    verificationTokenIssuedAt: timestamp('verification_token_issued_at', { withTimezone: true }),
    verificationMethod: siteVerificationMethodEnum('verification_method'),
    /** When the proof was last looked for, successfully or not. */
    verificationCheckedAt: timestamp('verification_checked_at', { withTimezone: true }),

    /**
     * Crawl configuration, per site.
     *
     * On the site rather than on each crawl because it is a property of how
     * hard THIS server may be asked to work — a shared host and a dedicated one
     * deserve different answers, and that answer should outlive one run.
     */
    crawlPageLimit: integer('crawl_page_limit').notNull().default(500),
    crawlMaxDepth: smallint('crawl_max_depth').notNull().default(10),
    /**
     * Concurrent requests to this origin.
     *
     * The CEILING is a CHECK constraint (1..4), because this decides how hard
     * somebody else's server is asked to work and must not be settable to a
     * number by any application path. The politeness POLICY that reads it —
     * backoff, Retry-After, crawl-delay — is not yet decided and will carry
     * its own ADR when robots handling lands.
     */
    crawlConcurrency: smallint('crawl_concurrency').notNull().default(2),
    /** Minimum gap between requests to this origin, milliseconds. */
    crawlDelayMs: integer('crawl_delay_ms').notNull().default(500),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One row per origin per workspace. Two workspaces MAY hold the same
     * origin — an agency and their client both legitimately registering the
     * client's site — so this is deliberately not globally unique.
     */
    uniqueIndex('sites_workspace_origin_unique').on(table.workspaceId, table.origin),
    index('sites_workspace_idx').on(table.workspaceId),
  ],
);

export type SiteRow = typeof sites.$inferSelect;
