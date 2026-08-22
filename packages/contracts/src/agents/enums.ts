/**
 * Agent platform enumerations.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single definition of every closed value set in the agent platform. The
 * database derives its native PostgreSQL enums from these constants, so the
 * two cannot drift.
 *
 * ⚠️ AUTONOMY IS NOT DEFINED HERE, DELIBERATELY.
 * `AutonomyLevel` already exists in `../ai/tool.ts` — four levels, enforced as
 * step 4 of `invokeTool`'s six-step guard chain and documented in
 * `docs/architecture/ai-agent-architecture.md`. An agent output records that
 * same level. A second, differently-shaped autonomy vocabulary would give the
 * platform two answers to "may an AI do this without asking", and the one the
 * guard chain does not read would be the one that drifts.
 *
 * @see ../ai/tool.ts
 * @see docs/decisions/ADR-0063-agent-platform-data-model.md
 */

/**
 * Lifecycle of one agent invocation.
 *
 * Deliberately three values. A run is in flight, it finished, or it did not —
 * `cancelled` is not here because nothing can cancel a run yet, and a status
 * nothing can produce is a value every query must handle for no reason.
 */
export const AGENT_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * What was decided about one draft.
 *
 * `edited` is distinct from `approved` on purpose: "a human approved this
 * as written" and "a human had to rewrite it first" are different facts about
 * the agent that produced it, and collapsing them would destroy the only
 * signal a future Brand-Voice agent could learn from.
 */
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'edited'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * The CRM outcome an agent output is being credited against.
 *
 * ⚠️ A NATIVE ENUM, NOT TEXT, AND THAT IS THE TRADE BEING MADE.
 * `ActivityType` is text because it grows with every feature. This set is
 * small, closed and carries analytical weight — it is what a revenue report
 * would group by — so a new value should cost a migration and a moment's
 * thought rather than appearing because someone typed a new string.
 */
export const ATTRIBUTION_OUTCOMES = [
  'contact_created',
  'acquisition_recorded',
  'opportunity_created',
  'opportunity_stage_changed',
  'opportunity_won',
] as const;
export type AttributionOutcome = (typeof ATTRIBUTION_OUTCOMES)[number];
