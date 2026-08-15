/**
 * Tenancy: agencies, workspaces and the membership graph.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The workspace is the tenancy boundary — every piece of customer data in
 * Growth OS belongs to exactly one workspace. An agency is an ownership and
 * administration layer above workspaces; it is NOT itself a data boundary, so
 * there is only ever one question to answer about any record: which workspace?
 *
 * THE CENTRAL INVARIANT
 * There is no `users.workspace_id`. Access is a graph:
 *
 *     users ──┬── memberships ────────▶ workspaces
 *             └── agency_memberships ─▶ agencies ──▶ workspaces (agency_id)
 *
 * @see docs/architecture/multi-tenancy.md
 * @see docs/decisions/ADR-0005-multi-tenancy-model.md
 */

import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { AGENCY_ROLES, WORKSPACE_ROLES } from '@growth-os/contracts';
import { users } from './identity';

/**
 * Native PostgreSQL enums, generated from the single role definition in
 * `@growth-os/contracts`.
 *
 * Deriving them from the TypeScript constant rather than restating the values
 * means the database and the capability matrix cannot drift — adding a role in
 * one place without the other becomes a compile error.
 */
export const workspaceRoleEnum = pgEnum('workspace_role', WORKSPACE_ROLES);
export const agencyRoleEnum = pgEnum('agency_role', AGENCY_ROLES);

export const agencies = pgTable(
  'agencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** URL-safe identifier. Reserved now for agency-scoped routing and white-label domains (Stage 19). */
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('agencies_slug_unique').on(table.slug)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),

    /**
     * Null for a direct business; set for an agency's client.
     *
     * `onDelete: 'set null'` rather than cascade: deleting an agency must not
     * destroy its clients' data. The workspaces survive as direct businesses,
     * which is also exactly the behaviour needed when an agency relationship
     * ends. Handing a client over is then a single column update rather than a
     * fan-out migration of permission rows that could partially fail.
     */
    agencyId: uuid('agency_id').references(() => agencies.id, { onDelete: 'set null' }),

    /**
     * IANA timezone. Present from the start because appointment scheduling
     * (Stage 11) and any daily metric rollup are wrong without it, and
     * backfilling a timezone onto existing data is guesswork.
     */
    timezone: text('timezone').notNull().default('UTC'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspaces_slug_unique').on(table.slug),
    index('workspaces_agency_id_idx').on(table.agencyId),
  ],
);

/**
 * Direct user↔workspace access.
 *
 * The composite unique index is the load-bearing constraint: without it a user
 * could hold two memberships in one workspace with different roles, and
 * "which role applies?" would become order-dependent — a silent authorization
 * bug rather than a loud one.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    role: workspaceRoleEnum('role').notNull().default('member'),

    /** Who granted this access. Null for the founding owner of a workspace. */
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_user_workspace_unique').on(table.userId, table.workspaceId),
    // "Which workspaces can this user reach?" — runs on every request.
    index('memberships_user_id_idx').on(table.userId),
    // "Who is in this workspace?" — the members administration screen.
    index('memberships_workspace_id_idx').on(table.workspaceId),
  ],
);

/**
 * User↔agency access, which grants transitive access to that agency's
 * workspaces via `workspaces.agency_id`.
 *
 * Transitive rather than copied into `memberships`: an agency taking on a new
 * client is then one insert, not N inserts across every agency employee, and
 * removing an employee is one delete rather than a fan-out with partial
 * failure modes.
 */
export const agencyMemberships = pgTable(
  'agency_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    role: agencyRoleEnum('role').notNull().default('agency_member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agency_memberships_user_agency_unique').on(table.userId, table.agencyId),
    index('agency_memberships_user_id_idx').on(table.userId),
    index('agency_memberships_agency_id_idx').on(table.agencyId),
  ],
);

export type AgencyRow = typeof agencies.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type AgencyMembershipRow = typeof agencyMemberships.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
export type NewMembershipRow = typeof memberships.$inferInsert;
