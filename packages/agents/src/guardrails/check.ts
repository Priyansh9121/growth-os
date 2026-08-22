/**
 * Running the guardrails against real stored output.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * `@growth-os/guardrails` is pure: it compares a draft against a corpus it is
 * GIVEN. That purity is what lets a draft be checked before it is persisted,
 * but it moves one responsibility here — **assembling a corpus that is
 * actually complete**, and saying so when it is not.
 *
 * ⚠️ THIS IS THE RISK ADR-0064 NAMED BUT COULD NOT ENFORCE.
 * That ADR recorded: _"nothing stops a caller passing an incomplete corpus,
 * and a check that compares against nothing returns `pass`"_. A pass produced
 * from half a corpus is indistinguishable from a pass produced from all of it,
 * and the second is the only one that means anything. So this service counts
 * what exists before it fetches, and **downgrades a `pass` to
 * `indeterminate` when the corpus was truncated** — the same honesty the
 * word-count floor already applies inside the check itself.
 *
 * ⚠️ `priorLimit` HAS NO DEFAULT, DELIBERATELY.
 * How much history counts as "what we have already published" is a product
 * question with no data behind it yet — no workspace has published anything.
 * Cost does not decide it either: measured at ~0.045 ms per prior, linear
 * (1,000 priors ≈ 45 ms, 10,000 ≈ 448 ms), so the comparison is not what
 * bounds the window; the fetch is. Rather than bake in a guess, the caller
 * states a limit and is told when it bound the answer.
 *
 * @see docs/decisions/ADR-0065-guardrail-corpus-assembly.md
 * @see docs/decisions/ADR-0064-self-duplication-guardrail.md
 */

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema } from '@growth-os/database';
import {
  evaluateGuardrails,
  type GuardrailOutcome,
  type GuardrailReport,
  type PriorOutput,
  type ProposedOutput,
} from '@growth-os/guardrails';
import { inTenant, requireCapability, type AgentsContext } from '../shared/context';

const { agentOutputs } = schema;

export interface CorpusSummary {
  /** Published outputs that exist in this workspace, counted before fetching. */
  readonly totalPublished: number;
  /** How many were actually compared against. */
  readonly compared: number;
  /** `true` when `totalPublished` exceeded the limit, so the answer is partial. */
  readonly truncated: boolean;
  readonly limit: number;
}

export interface GuardrailCheckResult {
  readonly report: GuardrailReport;
  readonly corpus: CorpusSummary;
}

export interface CheckProposedOutputOptions {
  /**
   * Most published priors to compare against, newest first.
   *
   * Required. See the file header: there is no defensible default yet, and a
   * silent one would decide a product question by accident.
   */
  readonly priorLimit: number;
}

/**
 * Check a proposed output against what this workspace has already published.
 *
 * The proposed output does NOT need to exist in the database — that is the
 * point of the guardrails package being pure. This is callable before a row is
 * written, which is the only moment at which catching a duplicate is cheap.
 *
 * @throws AuthorizationError when the actor lacks `workspace:ai:query`
 * @throws RangeError when `priorLimit` is not a positive integer
 */
export async function checkProposedOutput(
  context: AgentsContext,
  proposed: Omit<ProposedOutput, 'workspaceId'>,
  options: CheckProposedOutputOptions,
): Promise<GuardrailCheckResult> {
  requireCapability(context, 'workspace:ai:query');

  const { priorLimit } = options;
  if (!Number.isInteger(priorLimit) || priorLimit < 1) {
    // A limit of 0 would fetch nothing and report `pass` against an empty
    // corpus, which is the exact failure this service exists to prevent.
    throw new RangeError(`priorLimit must be a positive integer, received ${String(priorLimit)}`);
  }

  return inTenant(context, async (tx, workspace) => {
    // ⚠️ The workspace predicate is in the query as well as in RLS. RLS is the
    // guarantee; this is the same defence-in-depth the CRM applies, so a
    // mis-scoped transaction is a missing row rather than another tenant's.
    const scope = and(eq(agentOutputs.workspaceId, workspace), isNotNull(agentOutputs.publishedAt));

    // Counted BEFORE fetching, so truncation is detectable rather than
    // inferred from a full page — `rows.length === limit` cannot tell the
    // difference between "exactly the limit" and "more than the limit".
    const [counted] = await tx
      .select({ total: sql<string>`count(*)::text` })
      .from(agentOutputs)
      .where(scope);

    const totalPublished = Number(counted?.total ?? '0');

    const rows = await tx
      .select({
        id: agentOutputs.id,
        workspaceId: agentOutputs.workspaceId,
        kind: agentOutputs.kind,
        content: agentOutputs.content,
        publishedAt: agentOutputs.publishedAt,
      })
      .from(agentOutputs)
      .where(scope)
      .orderBy(desc(agentOutputs.publishedAt))
      .limit(priorLimit);

    const priors: PriorOutput[] = rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      content: row.content,
      publishedAt: row.publishedAt,
    }));

    const report = evaluateGuardrails({
      proposed: { ...proposed, workspaceId: workspace },
      priors,
    });

    const corpus: CorpusSummary = {
      totalPublished,
      compared: priors.length,
      truncated: totalPublished > priorLimit,
      limit: priorLimit,
    };

    return { report: withTruncationHonesty(report, corpus), corpus };
  });
}

/**
 * A `pass` over a truncated corpus is not a pass.
 *
 * ⚠️ `fail` is NEVER downgraded or upgraded. A duplicate found against a
 * partial corpus is still a duplicate — truncation can only hide matches, it
 * cannot invent one. Only the clean bill of health is affected, because that
 * is the verdict truncation can falsify.
 */
function withTruncationHonesty(report: GuardrailReport, corpus: CorpusSummary): GuardrailReport {
  if (!corpus.truncated || report.outcome !== 'pass') return report;

  const outcome: GuardrailOutcome = 'indeterminate';
  return {
    outcome,
    findings: [
      ...report.findings,
      {
        check: 'corpus-completeness',
        outcome: 'indeterminate',
        message:
          `Compared against the ${corpus.compared} most recent published outputs, but this ` +
          `workspace has ${corpus.totalPublished}. Nothing matched among those checked, which ` +
          `is not the same as nothing matching.`,
        details: {
          totalPublished: corpus.totalPublished,
          compared: corpus.compared,
          limit: corpus.limit,
        },
      },
    ],
  };
}
