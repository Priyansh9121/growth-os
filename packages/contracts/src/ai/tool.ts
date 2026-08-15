/**
 * The Growth OS agent tool contract.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * This file defines the ONLY way an AI agent is permitted to interact with
 * Growth OS. It is the enforcement point for the product's central AI
 * principle:
 *
 *     AI UNDERSTANDS. THE APPLICATION DECIDES.
 *     THE SERVICE VALIDATES. THE DATABASE CONFIRMS.
 *
 * A model never reads or writes state directly. It emits a tool call; the
 * runtime validates the arguments against a schema, checks that the actor
 * holds the required capability, checks that the tool's autonomy level is
 * permitted for this workspace, invokes a deterministic application service,
 * validates the result, and returns it. Every one of those steps can refuse.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * The failure mode this prevents is a model *claiming* an action succeeded.
 * An LLM asked to book an appointment will happily reply "You're booked for
 * Tuesday at 2 PM" without anything having been written. Because the tool
 * result is produced by the database transaction rather than the model, the
 * agent can only report what actually happened.
 *
 * STATUS
 * The contract and registry are implemented and tested. NO MODEL IS
 * CONNECTED — see docs/architecture/ai-agent-architecture.md for the runtime
 * planned at Stage 7.
 */

import type { z } from 'zod';
import type { Capability } from '../tenancy/capabilities';
import type { TenantActor } from '../tenancy/actor';

/**
 * How much independence an agent has for a given action.
 *
 * The product default is L2. Anything above L2 is opt-in per workspace, per
 * action class, and bounded by a budget.
 */
export const AutonomyLevel = {
  /** Describe and advise. Cannot change anything. */
  RECOMMEND: 1,
  /** Produce a draft or a proposed change; a human must approve it. */
  DRAFT_WITH_APPROVAL: 2,
  /** Execute actions the workspace pre-approved by class. */
  PRE_APPROVED: 3,
  /** Execute freely within explicit policy and budget limits. */
  AUTONOMOUS: 4,
} as const;

export type AutonomyLevel = (typeof AutonomyLevel)[keyof typeof AutonomyLevel];

/** Product default. Changing this changes the safety posture of the platform. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = AutonomyLevel.DRAFT_WITH_APPROVAL;

/**
 * Whether a tool observes or changes the world.
 *
 * `read` tools may run at any autonomy level. `write` tools require the
 * workspace's configured level to be at least the tool's `minimumAutonomy`,
 * and always produce an audit event.
 */
export type ToolEffect = 'read' | 'write';

/**
 * Everything a tool needs in order to act, and nothing more.
 *
 * Note what is absent: a database handle, a raw connection, the request, and
 * any credential. A tool reaches the world only through application services,
 * which perform their own authorization. This keeps the blast radius of a
 * prompt-injection success bounded by the tool set, not by the process.
 */
export interface ToolContext {
  /** The human on whose behalf the agent is acting, bound to one workspace. */
  readonly tenant: TenantActor;
  /** Correlates every tool call in one agent run, for tracing and audit. */
  readonly runId: string;
  /** Cooperative cancellation — a run may be aborted by budget or by the user. */
  readonly signal: AbortSignal;
}

/**
 * A tool an agent may call.
 *
 * @typeParam TInput  Validated argument shape.
 * @typeParam TOutput Validated result shape.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  /** Stable identifier exposed to the model. `domain.action`, e.g. `seo.getKeywordPerformance`. */
  readonly name: string;

  /**
   * Description shown to the model. This is prompt surface: it must be
   * precise about what the tool does and what it refuses to do, because it is
   * the model's only guide to correct use.
   */
  readonly description: string;

  /** Schema for arguments. Model output is untrusted input and is always parsed. */
  readonly inputSchema: z.ZodType<TInput>;

  /**
   * Schema for the result.
   *
   * Validating our own output looks redundant but is not: it guarantees the
   * model never receives a shape it was not promised, and it catches a service
   * returning more than intended — which is how tenant data leaks into a
   * model context.
   */
  readonly outputSchema: z.ZodType<TOutput>;

  /** Does this tool observe or change state? */
  readonly effect: ToolEffect;

  /**
   * The capability the acting user must hold.
   *
   * The agent's permissions are always a SUBSET of the user's. An agent can
   * never do something on a user's behalf that the user could not do
   * themselves — this is what stops "ask the AI to do it" from becoming a
   * privilege-escalation path.
   */
  readonly requiredCapability: Capability;

  /** Minimum workspace autonomy setting for this tool to be callable. */
  readonly minimumAutonomy: AutonomyLevel;

  /**
   * Estimated cost units, for per-workspace budgeting. Prevents an agent loop
   * from spending unbounded money.
   */
  readonly costUnits: number;

  /** The deterministic implementation. Must be idempotent where `effect` is `write`. */
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

/** Discriminated result of a tool invocation. Tool failure is data, not an exception. */
export type ToolResult<TOutput> =
  | { readonly ok: true; readonly output: TOutput }
  | { readonly ok: false; readonly error: ToolFailure };

/**
 * Why a tool call failed.
 *
 * Returned to the agent as structured data so it can respond usefully —
 * `unavailable` with alternatives lets a voice agent offer another time slot
 * rather than inventing one.
 */
export interface ToolFailure {
  readonly reason:
    | 'invalid_input'
    | 'forbidden'
    | 'autonomy_insufficient'
    | 'budget_exceeded'
    | 'not_found'
    | 'unavailable'
    | 'internal';
  /** Safe to include in the model's context. Never contains internals. */
  readonly message: string;
  /** Machine-readable extras, e.g. alternative appointment times. */
  readonly details?: Record<string, unknown>;
}

/**
 * Helper to define a tool with full type inference.
 *
 * Exists so tools are declared as data with an `execute` function rather than
 * as classes, which keeps them trivially testable in isolation.
 */
export function defineTool<TInput, TOutput>(
  tool: AgentTool<TInput, TOutput>,
): AgentTool<TInput, TOutput> {
  return tool;
}
