import 'server-only';

/**
 * The Growth AI tool set.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * A working, end-to-end example of the AI tool contract — not a placeholder.
 * `growth.getSnapshot` is a real registered tool with real schemas that runs
 * through the real `invokeTool` guard chain (capability → autonomy → budget →
 * input schema → execute → output schema).
 *
 * WHY BUILD A TOOL BEFORE THERE IS A MODEL
 * Because the guard chain is the part that must be right, and it is far easier
 * to get right — and to test — without a model in the loop. When an agent
 * runtime arrives at Stage 7, it plugs into a boundary that is already proven,
 * rather than the boundary being invented under deadline alongside prompt
 * engineering.
 *
 * WHAT THIS DEMONSTRATES
 *  - The tool receives a `TenantActor`, never a database handle. A
 *    prompt-injection success is bounded by the tool set, not by the process.
 *  - The tool's data is the SAME data the user sees on screen, so the agent
 *    can never cite a number the user cannot verify.
 *  - Output is schema-validated on the way back, so a service returning more
 *    than the contract promises cannot leak into a model's context.
 *
 * @see docs/architecture/ai-agent-architecture.md
 * @see packages/contracts/src/ai/tool.ts
 */

import { z } from 'zod';
import { AutonomyLevel, defineTool, ToolRegistry } from '@growth-os/contracts';
import { buildFixtureSnapshot } from '../../lib/fixtures/growth-demo';
import { CRM_TOOLS } from './crm-tools';

const metricSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  formatted: z.string(),
  provenance: z.enum(['live', 'estimate', 'unavailable', 'fixture']),
});

const opportunitySchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  summary: z.string(),
  recommendation: z.string(),
  estimatedMonthlyValue: z.number().nullable(),
  evidence: z.array(z.object({ label: z.string(), value: z.string(), source: z.string() })),
});

const snapshotOutputSchema = z.object({
  workspaceName: z.string(),
  periodLabel: z.string(),
  /**
   * Surfaced to the model deliberately. An agent must know it is reasoning
   * over fixtures so it can say so, rather than presenting demo numbers as
   * measurements — Principle 3 applies to the AI's output too.
   */
  provenance: z.enum(['live', 'estimate', 'unavailable', 'fixture']),
  headline: metricSchema,
  metrics: z.array(metricSchema),
  opportunities: z.array(opportunitySchema),
});

/**
 * Read the current growth snapshot for the active workspace.
 *
 * `effect: 'read'` and `minimumAutonomy: RECOMMEND`, so it is callable at
 * every autonomy level — reading cannot change anything.
 */
export const getGrowthSnapshotTool = defineTool({
  name: 'growth.getSnapshot',
  description:
    'Returns the current growth metrics and ranked opportunities for the active workspace, ' +
    'including the provenance of every value. Use this before answering any question about ' +
    'performance. Never state a number that did not come from this tool.',
  inputSchema: z.object({}),
  outputSchema: snapshotOutputSchema,
  effect: 'read',
  requiredCapability: 'workspace:data:read',
  minimumAutonomy: AutonomyLevel.RECOMMEND,
  costUnits: 1,

  async execute(_input, context) {
    // The workspace comes from the authorized `TenantActor`, NOT from the
    // model's arguments. An agent cannot request another tenant's data because
    // it has no way to name one — the scope is supplied by the runtime.
    const { workspace } = context.tenant;

    const snapshot = buildFixtureSnapshot(
      workspace.workspaceId,
      workspace.workspaceName,
      new Date().toISOString(),
    );

    return {
      workspaceName: snapshot.workspaceName,
      periodLabel: snapshot.periodLabel,
      provenance: snapshot.provenance,
      headline: {
        key: snapshot.headline.key,
        label: snapshot.headline.label,
        value: snapshot.headline.value,
        formatted: snapshot.headline.formatted,
        provenance: snapshot.headline.provenance,
      },
      metrics: snapshot.metrics.map((metric) => ({
        key: metric.key,
        label: metric.label,
        value: metric.value,
        formatted: metric.formatted,
        provenance: metric.provenance,
      })),
      opportunities: snapshot.opportunities.map((opportunity) => ({
        id: opportunity.id,
        title: opportunity.title,
        priority: opportunity.priority,
        summary: opportunity.summary,
        recommendation: opportunity.recommendation,
        estimatedMonthlyValue: opportunity.estimatedMonthlyValue,
        evidence: [...opportunity.evidence],
      })),
    };
  },
});

/**
 * The registry available to the Growth Strategist agent.
 *
 * Stage 2 adds five read-only CRM tools. Every one is `effect: 'read'` — agents
 * still have NO mutation capability. Write tools (booking, content changes,
 * workflow activation) arrive with the agent runtime at Stage 7 and will
 * require `minimumAutonomy` of at least `DRAFT_WITH_APPROVAL` plus the
 * approval workflow.
 *
 * The CRM tools return deliberately minimised shapes — aggregates, first names
 * and identifiers, never email addresses or phone numbers. Tool output becomes
 * model context, so the narrowest shape that answers the question is the only
 * safe one to return.
 */
export const growthToolRegistry = new ToolRegistry([
  getGrowthSnapshotTool as never,
  ...(CRM_TOOLS as readonly unknown[] as never[]),
]);
