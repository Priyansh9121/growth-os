/**
 * The agent tool registry and its invocation guard.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * `invokeTool` is the single choke point between a model's intent and the
 * application's behaviour. Every guard the AI architecture depends on lives
 * here, in one auditable function, rather than being re-implemented per tool:
 *
 *   1. the tool exists
 *   2. arguments parse against the tool's schema
 *   3. the acting user holds the required capability
 *   4. the workspace's autonomy level permits the tool
 *   5. the run has budget remaining
 *   6. the result parses against the tool's output schema
 *
 * Guards 3 and 4 are deliberately separate. Capability answers "may this
 * person do this at all?"; autonomy answers "may an AI do it without asking?".
 * Collapsing them would make it impossible to let a user act while requiring
 * their agent to seek approval — which is the entire point of Level 2.
 *
 * @see docs/architecture/ai-agent-architecture.md
 */

import type { AgentTool, AutonomyLevel, ToolContext, ToolFailure, ToolResult } from './tool';
import { workspaceRoleHasCapability } from '../tenancy/capabilities';

/** Immutable set of tools available to a given agent. */
export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, AgentTool<never, unknown>>;

  constructor(tools: readonly AgentTool<never, unknown>[]) {
    const map = new Map<string, AgentTool<never, unknown>>();
    for (const tool of tools) {
      if (map.has(tool.name)) {
        // A duplicate name means two tools compete for one identifier and the
        // model's call becomes ambiguous. Fail at construction, not at runtime.
        throw new Error(`Duplicate agent tool name: ${tool.name}`);
      }
      map.set(tool.name, tool);
    }
    this.#tools = map;
  }

  get(name: string): AgentTool<never, unknown> | undefined {
    return this.#tools.get(name);
  }

  list(): readonly AgentTool<never, unknown>[] {
    return [...this.#tools.values()];
  }

  /**
   * The subset a specific caller may actually use.
   *
   * Used to build the tool list sent to a model: a model should never be told
   * about a tool it would be refused. Advertising unavailable tools produces
   * confident promises the system then rejects, which reads to the user as the
   * product being broken.
   */
  availableFor(
    context: ToolContext,
    autonomy: AutonomyLevel,
  ): readonly AgentTool<never, unknown>[] {
    return this.list().filter(
      (tool) =>
        workspaceRoleHasCapability(context.tenant.workspace.role, tool.requiredCapability) &&
        autonomy >= tool.minimumAutonomy,
    );
  }
}

export interface InvokeOptions {
  /** The workspace's configured autonomy level for this agent. */
  readonly autonomy: AutonomyLevel;
  /** Remaining cost budget for this run, in the same units as `tool.costUnits`. */
  readonly remainingBudget: number;
}

function failure(
  reason: ToolFailure['reason'],
  message: string,
  details?: Record<string, unknown>,
): ToolResult<never> {
  return {
    ok: false,
    error: details === undefined ? { reason, message } : { reason, message, details },
  };
}

/**
 * Validate, authorize and execute a tool call.
 *
 * Never throws for an expected refusal — a refusal is returned as data so the
 * agent can reason about it and tell the user something true. Only a genuine
 * defect inside a tool produces `internal`, and even then the underlying error
 * is not surfaced to the model, because tool output becomes model context and
 * internals must not enter it.
 *
 * @param rawInput Arguments as produced by the model. UNTRUSTED.
 */
export async function invokeTool(
  registry: ToolRegistry,
  toolName: string,
  rawInput: unknown,
  context: ToolContext,
  options: InvokeOptions,
): Promise<ToolResult<unknown>> {
  const tool = registry.get(toolName);
  if (!tool) {
    return failure('not_found', `No tool named "${toolName}".`);
  }

  // Capability before schema parsing: a caller who may not use this tool
  // should not receive schema feedback that describes its arguments.
  if (!workspaceRoleHasCapability(context.tenant.workspace.role, tool.requiredCapability)) {
    return failure('forbidden', 'You do not have permission to perform this action.');
  }

  if (options.autonomy < tool.minimumAutonomy) {
    return failure(
      'autonomy_insufficient',
      'This action needs approval before it can be performed.',
      { requiredAutonomy: tool.minimumAutonomy, currentAutonomy: options.autonomy },
    );
  }

  if (tool.costUnits > options.remainingBudget) {
    return failure('budget_exceeded', 'This request exceeds the remaining budget for this run.');
  }

  const parsedInput = tool.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    // Issues are returned to the MODEL (not the end user) so it can correct
    // its call. They describe the model's own arguments, so they leak nothing.
    return failure('invalid_input', 'The arguments provided were not valid for this tool.', {
      issues: parsedInput.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (context.signal.aborted) {
    return failure('unavailable', 'The request was cancelled.');
  }

  let output: unknown;
  try {
    output = await tool.execute(parsedInput.data as never, context);
  } catch (error) {
    // Deliberately opaque: the caught error may contain internals, and tool
    // output flows into the model's context window.
    return failure('internal', 'The action could not be completed.', {
      toolName,
      runId: context.runId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }

  // Validating our own output guards against a service returning more than the
  // contract promises — which is how tenant data reaches a model context.
  const parsedOutput = tool.outputSchema.safeParse(output);
  if (!parsedOutput.success) {
    return failure('internal', 'The action produced an unexpected result.', {
      toolName,
      runId: context.runId,
    });
  }

  return { ok: true, output: parsedOutput.data };
}
