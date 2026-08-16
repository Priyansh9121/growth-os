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

import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { SITE_STATUSES, SITE_VERIFICATION_STATES } from '@growth-os/contracts';
import { users } from './identity';
import { workspaces } from './tenancy';

export const siteStatusEnum = pgEnum('site_status', SITE_STATUSES);
export const siteVerificationEnum = pgEnum('site_verification_state', SITE_VERIFICATION_STATES);

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
    /** The token a DNS TXT record must carry. Generated on demand, Stage 4. */
    verificationToken: text('verification_token'),

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
