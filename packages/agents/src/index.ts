/**
 * @growth-os/agents — services for the agent platform.
 *
 * Today this is one thing: assembling the corpus a guardrail needs from
 * tenant-scoped storage, and reporting when that corpus was incomplete.
 *
 * @see docs/decisions/ADR-0065-guardrail-corpus-assembly.md
 */

export {
  checkProposedOutput,
  type CheckProposedOutputOptions,
  type CorpusSummary,
  type GuardrailCheckResult,
} from './guardrails/check';

export {
  contextNow,
  inTenant,
  requireCapability,
  workspaceId,
  type AgentsContext,
  type AgentsDependencies,
} from './shared/context';
