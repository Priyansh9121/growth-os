/**
 * POST /api/ai/ask — the Growth AI boundary.
 *
 * ⚠️  NO LANGUAGE MODEL IS CONNECTED. This endpoint runs in an explicitly
 * labelled offline mode and says so in its response.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Proves the AI boundary end to end without a model: authenticate → authorize
 * → resolve tenant → invoke a typed tool through the guard chain → return
 * evidence-carrying output. When a model arrives at Stage 7 it slots in as a
 * PLANNER over this same path; nothing about the security shape changes.
 *
 * WHY THIS EXISTS NOW RATHER THAN AS A STUB
 * A stub that returns a hard-coded string would prove nothing and would have
 * to be thrown away. This exercises the real registry, the real capability
 * check and the real schema validation, so the boundary is tested from day
 * one — the part that must not be improvised later.
 *
 * WHY IT REFUSES TO INVENT AN ANSWER
 * Principle 3. With no model connected, the honest response is to say so and
 * return the tool's real output, not to fabricate analysis. The UI renders it
 * as data plus an explicit "not connected" state.
 *
 * @see docs/architecture/ai-agent-architecture.md
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  AutonomyLevel,
  DEFAULT_AUTONOMY_LEVEL,
  invokeTool,
  ValidationError,
} from '@growth-os/contracts';
import { requireWorkspaceAccess } from '@growth-os/auth';
import { AUDIT_EVENTS, withTenantTransaction, writeAuditEvent } from '@growth-os/database';
import { randomUUID } from 'node:crypto';
import { getDependencies } from '../../../../server/dependencies';
import { buildRequestContext, errorResponse, rejectUntrustedOrigin } from '../../../../server/http';
import { requireActor } from '../../../../server/auth-context';
import { growthToolRegistry } from '../../../../server/ai/growth-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const askInputSchema = z.object({
  /**
   * Length-capped because it will become part of a model prompt. Unbounded
   * user text in a prompt is both a cost vector and the primary carrier for
   * prompt injection.
   */
  question: z.string().trim().min(1, 'Ask a question.').max(1000),
  workspaceId: z.uuid(),
});

/** Per-request cost ceiling, in the tool contract's cost units. */
const RUN_BUDGET = 20;

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);

  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { actor } = await requireActor();

    const body: unknown = await request.json().catch(() => null);
    const parsed = askInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new ValidationError(
        'Check your question.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    // Authorization before anything else touches workspace data.
    const tenant = requireWorkspaceAccess(actor, parsed.data.workspaceId, 'workspace:ai:query');

    const deps = getDependencies();
    const runId = randomUUID();

    await withTenantTransaction(deps.db, tenant.workspace.workspaceId, async (tx) => {
      await writeAuditEvent(
        deps.db,
        {
          workspaceId: tenant.workspace.workspaceId,
          actorUserId: actor.userId,
          eventName: AUDIT_EVENTS.AI_QUERY_SUBMITTED,
          accessPath: tenant.workspace.via,
          correlationId: context.correlationId,
          // The question text is NOT recorded. It is user content, may contain
          // customer details, and is not needed to audit that a query occurred.
          metadata: { runId, questionLength: parsed.data.question.length },
        },
        tx,
      );
    });

    // Bound the run so a hung tool cannot hold a request open indefinitely.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const result = await invokeTool(
        growthToolRegistry,
        'growth.getSnapshot',
        {},
        { tenant, runId, signal: controller.signal },
        { autonomy: DEFAULT_AUTONOMY_LEVEL, remainingBudget: RUN_BUDGET },
      );

      if (!result.ok) {
        // A refusal is data, not an exception — the same shape a real agent
        // would reason over.
        return NextResponse.json(
          {
            mode: 'offline',
            runId,
            answer: null,
            toolFailure: result.error,
          },
          { status: 200 },
        );
      }

      return NextResponse.json(
        {
          /**
           * The client renders this mode as an explicit "no model connected"
           * state. It is a contract field, not a debug flag — the UI must not
           * be able to present offline output as an AI answer.
           */
          mode: 'offline',
          runId,
          autonomyLevel: DEFAULT_AUTONOMY_LEVEL,
          autonomyLabel: 'Draft with approval',
          notice:
            'Growth AI is not connected to a language model yet. This response is the ' +
            'raw output of the growth.getSnapshot tool, returned through the same ' +
            'authorization and validation path a future agent will use.',
          question: parsed.data.question,
          toolName: 'growth.getSnapshot',
          evidence: result.output,
          availableTools: growthToolRegistry
            .availableFor({ tenant, runId, signal: controller.signal }, AutonomyLevel.AUTONOMOUS)
            .map((tool) => ({
              name: tool.name,
              effect: tool.effect,
              minimumAutonomy: tool.minimumAutonomy,
            })),
        },
        { status: 200 },
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return errorResponse(error, context);
  }
}
