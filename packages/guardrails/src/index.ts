/**
 * @growth-os/guardrails — what must be true before a human is asked to approve
 * an agent's draft.
 *
 * ⚠️ PURE BY CONSTRUCTION. This package has no dependencies, opens no socket
 * and touches no database. The comparison corpus is passed in, which is what
 * lets a draft be checked BEFORE it is ever persisted — the only moment at
 * which catching a duplicate is still cheap.
 *
 * @see docs/decisions/ADR-0064-self-duplication-guardrail.md
 */

export {
  evaluateGuardrails,
  selfDuplicationCheck,
  PHASE_0_CHECKS,
  type GuardrailCheck,
  type GuardrailFinding,
  type GuardrailInput,
  type GuardrailOutcome,
  type GuardrailReport,
} from './pipeline';

export {
  CrossWorkspaceCorpusError,
  MIN_COMPARABLE_WORDS,
  SIMILARITY_THRESHOLD,
  detectSelfDuplication,
  selectComparable,
  type DuplicateMatch,
  type PriorOutput,
  type ProposedOutput,
  type SelfDuplicationResult,
} from './self-duplication';

export { fingerprint, jaccard, extractText, toWords, shingle } from './text';
