/**
 * The agent platform — what an agent did, proposed, was told, and earned.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Five tables, each recording a fact nothing else in the schema records:
 *
 *   campaigns           the coordination unit. "What is this run part of?"
 *   agent_runs          one invocation. "What ran, when, and how did it end?"
 *   agent_outputs       one draft. "What did it propose?"
 *   approvals           one human decision. "What did we say about the draft?"
 *   attribution_events  the join. "Which draft preceded this CRM outcome?"
 *
 * ⚠️ `agent_runs.id` IS `ToolContext.runId`.
 * `contracts/src/ai/tool.ts` has required a `runId` on every tool call since
 * before this table existed, describing it as correlating every call in one
 * run "for tracing and audit". It was a foreign key with nothing on the other
 * end. This is the other end.
 *
 * ⚠️ AUTONOMY IS NOT REDEFINED HERE.
 * `agent_outputs.autonomy_level` stores the existing `AutonomyLevel` (1–4)
 * from `contracts/src/ai/tool.ts`, bounded by a CHECK in migration 0014.
 * Phase 0 writes 2 (DRAFT_WITH_APPROVAL) to every row and builds no
 * auto-approve path — the column exists so that the level an output was
 * produced under is recoverable later, not because anything varies it yet.
 *
 * ⚠️ NO CREDENTIALS, IN ANY COLUMN.
 * The original brief included a `channel_credentials` table. It is deferred to
 * the connector phase: this repository has no reversible-encryption primitive
 * anywhere, only one-way HMAC and hashing, so building it here would mean
 * inventing a secrets pattern as a side effect of a data-model task.
 * `agent_runs.inputs` is structured input to a run and is NOT a place to put
 * a token (ADR-0063 alternative B).
 *
 * ⚠️ ATTRIBUTION RE-RECORDS NO CHANNEL DATA.
 * `acquisitions` already owns provenance under ADR-0012 — source, platform,
 * confidence, UTM, landing path, channel detail. `attribution_events` adds one
 * fact to it: which output preceded the outcome. Copying UTM columns onto this
 * join would create a second set of values, written by something that cannot
 * observe them, that drift from the row that can.
 *
 * @see docs/decisions/ADR-0063-agent-platform-data-model.md
 * @see docs/decisions/ADR-0012-provenance-model.md
 * @see docs/architecture/ai-agent-architecture.md
 */

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { AGENT_RUN_STATUSES, APPROVAL_DECISIONS, ATTRIBUTION_OUTCOMES } from '@growth-os/contracts';
import { users } from './identity';
import { workspaces } from './tenancy';
import { acquisitions, contacts, opportunities } from './crm';

export const agentRunStatusEnum = pgEnum('agent_run_status', AGENT_RUN_STATUSES);
export const approvalDecisionEnum = pgEnum('approval_decision', APPROVAL_DECISIONS);
export const attributionOutcomeEnum = pgEnum('attribution_outcome', ATTRIBUTION_OUTCOMES);

// ---------------------------------------------------------------------------
// campaigns — the coordination unit
// ---------------------------------------------------------------------------

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Bounded by a CHECK in 0014: non-empty, at most 200 characters. */
    name: text('name').notNull(),
    description: text('description'),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),

    /**
     * NULL means open-ended, not "unknown".
     *
     * The brief called a campaign "time-boxed" and most are, but a always-on
     * nurture campaign is a real thing and forcing a fictional end date would
     * make every query that filters on it wrong. A CHECK in 0014 enforces
     * `ends_at > starts_at` whenever a value IS present.
     */
    endsAt: timestamp('ends_at', { withTimezone: true }),

    /** The record outlives the person who created it. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "What is running for this workspace right now?"
    index('campaigns_workspace_starts_idx').on(table.workspaceId, table.startsAt),
  ],
);

// ---------------------------------------------------------------------------
// agent_runs — one invocation
// ---------------------------------------------------------------------------

export const agentRuns = pgTable(
  'agent_runs',
  {
    /** ⚠️ This is `ToolContext.runId`. Do not introduce a second run identifier. */
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /**
     * NULL is normal, not exceptional: an agent may run outside any campaign.
     * `set null` because deleting a campaign must not erase the record that
     * work was done under it.
     */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),

    /**
     * Which agent ran. Text, not an enum, and deliberately so — the set of
     * agents grows with every feature, which is the same trade `ActivityType`
     * makes. Bounded by a CHECK in 0014.
     *
     * There is no agent registry table to reference: no agent exists yet.
     */
    agentKey: text('agent_key').notNull(),

    status: agentRunStatusEnum('status').notNull().default('running'),

    /**
     * The structured input the run was given. NOT NULL with a `{}` default so
     * "no inputs" is an empty object rather than a NULL every reader must
     * handle.
     *
     * ⚠️ Never a credential. See the file header.
     */
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * NULL exactly while the run is `running`. 0014 enforces both directions:
     * a finished run must have one, a running run must not.
     */
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /** Present only when `status = 'failed'`, enforced by CHECK in 0014. */
    failureReason: text('failure_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_runs_workspace_started_idx').on(table.workspaceId, table.startedAt),
    index('agent_runs_campaign_idx').on(table.campaignId, table.startedAt),
    // "Which runs are still in flight?" — the reaper's query shape.
    index('agent_runs_workspace_status_idx').on(table.workspaceId, table.status),
  ],
);

// ---------------------------------------------------------------------------
// agent_outputs — one proposed action
// ---------------------------------------------------------------------------

export const agentOutputs = pgTable(
  'agent_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /**
     * ⚠️ NOT NULL, AND THAT IS THE POINT OF THIS ENTIRE MODEL.
     *
     * An output that cannot name the run that produced it is not a record of
     * anything — it is an unattributed claim about what an AI decided. This is
     * enforced by the DATABASE, not by a service that some future code path
     * might not call, and a test asserts the row is REFUSED rather than
     * asserting that validation ran (AGENTS.md §6).
     */
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),

    /** What sort of draft this is. Bounded by a CHECK in 0014. */
    kind: text('kind').notNull(),

    /** The draft itself. Shape varies by `kind` and is validated in contracts. */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),

    /**
     * The existing `AutonomyLevel` (1–4) from contracts, NOT a second
     * vocabulary. CHECK BETWEEN 1 AND 4 in 0014 — "limits live in the
     * database" (AGENTS.md §5).
     *
     * Every row in Phase 0 is 2. The default matches
     * `DEFAULT_AUTONOMY_LEVEL`, and `enums.test.ts` asserts the two agree.
     */
    autonomyLevel: smallint('autonomy_level').notNull().default(2),

    /**
     * When this draft actually reached the world. NULL = never published.
     * `attribution_events` may only reference a published output, which 0014
     * enforces with a trigger — an unpublished draft cannot have caused
     * anything.
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_outputs_run_idx').on(table.agentRunId),
    index('agent_outputs_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// approvals — one human decision about one draft
// ---------------------------------------------------------------------------

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    agentOutputId: uuid('agent_output_id')
      .notNull()
      .references(() => agentOutputs.id, { onDelete: 'cascade' }),

    decision: approvalDecisionEnum('decision').notNull(),

    /**
     * NULL when the deciding user has since been deleted. The decision is a
     * record of what happened and survives the person, exactly as
     * `acquisitions.qualified_by_user_id` does.
     */
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * ⚠️ Present if and only if `decision = 'edited'`, enforced by CHECK in
     * 0014 in BOTH directions.
     *
     * `edited` exists as a decision separate from `approved` because "approved
     * as written" and "had to be rewritten first" are different facts about the
     * agent that produced the draft. An `edited` row with no diff would destroy
     * that distinction while appearing to preserve it.
     */
    editDiff: jsonb('edit_diff').$type<Record<string, unknown>>(),

    note: text('note'),
  },
  (table) => [
    /**
     * ⚠️ NOT unique on `agent_output_id`, and the table is append-only (no
     * UPDATE policy in 0014).
     *
     * A decision that can be rewritten is not an audit record — the same
     * reasoning that makes `activities` append-only. Re-deciding appends a
     * second row; the current decision is the latest `decided_at`. A UNIQUE
     * constraint can be added later if a workflow proves re-deciding is
     * wrong, which is easier than removing one a workflow needs.
     */
    index('approvals_output_decided_idx').on(table.agentOutputId, table.decidedAt),
    index('approvals_workspace_decided_idx').on(table.workspaceId, table.decidedAt),
  ],
);

// ---------------------------------------------------------------------------
// attribution_events — the join onto ADR-0012's provenance
// ---------------------------------------------------------------------------

/**
 * Which published output preceded which CRM outcome.
 *
 * ⚠️ "PRECEDED", NOT "CAUSED". This table records a sequence that was observed,
 * not a causal claim. Nothing here should be rendered as "this agent earned
 * £X" without a model that says why precedence implies credit — which is a
 * decision this table deliberately does not make on anyone's behalf.
 *
 * ⚠️ There is no `activity_id`, deliberately. Every value in
 * `ATTRIBUTION_OUTCOMES` names a contact, an acquisition or an opportunity;
 * none names an activity, so a column for one would be unreachable by any
 * outcome the enum permits.
 *
 * Exactly one of the three target columns is non-NULL, and which one is
 * determined by `outcome`. Both halves are CHECK constraints in 0014.
 */
export const attributionEvents = pgTable(
  'attribution_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    agentOutputId: uuid('agent_output_id')
      .notNull()
      .references(() => agentOutputs.id, { onDelete: 'cascade' }),

    outcome: attributionOutcomeEnum('outcome').notNull(),

    /** Set when `outcome = 'contact_created'`. */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    /** Set when `outcome = 'acquisition_recorded'`. */
    acquisitionId: uuid('acquisition_id').references(() => acquisitions.id, {
      onDelete: 'cascade',
    }),
    /** Set for the three `opportunity_*` outcomes. */
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),

    /** When the CRM outcome happened — not when this row was written. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('attribution_events_output_idx').on(table.agentOutputId),
    // "What did agents produce this month, by outcome?"
    index('attribution_events_workspace_outcome_idx').on(
      table.workspaceId,
      table.outcome,
      table.occurredAt,
    ),
  ],
);

export type CampaignRow = typeof campaigns.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentOutputRow = typeof agentOutputs.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type AttributionEventRow = typeof attributionEvents.$inferSelect;
