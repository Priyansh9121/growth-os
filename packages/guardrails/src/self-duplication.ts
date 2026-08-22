/**
 * Self-duplication: has this workspace already published this?
 *
 * ARCHITECTURAL RESPONSIBILITY
 * An agent with no memory of what it published last month will cheerfully
 * publish it again. That is not a hypothetical failure — it is the default
 * behaviour of a stateless generator pointed at a stable brief. The damage is
 * search engines de-duplicating the pair and picking the wrong winner, and a
 * customer's audience being sent the same thing twice.
 *
 * ⚠️ WORKSPACE-INTERNAL ONLY, STRUCTURALLY.
 * This compares a draft against the workspace's OWN prior output. It is not
 * plagiarism detection, it makes no external call, and it cannot: the corpus
 * is passed in. A prior from a different workspace is a programming error and
 * throws rather than being filtered away quietly — silently ignoring it would
 * turn a tenancy bug into a check that merely finds nothing.
 *
 * ⚠️ THREE OUTCOMES, NOT TWO — AND THE THIRD WAS FORCED BY MEASUREMENT.
 * The brief specified pass/fail. Short documents make that dishonest: two
 * genuinely different 20-word drafts that share one line of trade boilerplate
 * measured 0.714 similar, higher than a real republication with a paragraph
 * appended (0.721). Below `MIN_COMPARABLE_WORDS` this check reports
 * `indeterminate` instead of guessing, because returning `pass` there would be
 * a clearance it did not earn.
 *
 * @see docs/decisions/ADR-0064-self-duplication-guardrail.md
 */

import { fingerprint, jaccard, toWords, extractText } from './text';

/**
 * Jaccard score at or above which two drafts are called duplicates.
 *
 * Measured, not chosen. Against a 51-shingle marketing draft:
 *
 *   1.000  identical, and identical but repunctuated / recased
 *   0.925  the same prose split across different fields
 *   0.721  republished with one extra paragraph appended
 *   0.384  lightly reworded — synonym swaps over the same skeleton
 *   0.246  DIFFERENT topics sharing a line of trade boilerplate (≥40 words)
 *   0.000  heavily rewritten, same topic and facts
 *
 * 0.30 sits in the gap between the worst false positive and the weakest true
 * one. The margin on the false-positive side is 0.054, which is not large —
 * see the ADR for why the asymmetry is acceptable: every Phase 0 output is
 * human-reviewed at autonomy level 2 regardless, so a false flag costs one
 * line in a review that was already happening, while a miss costs a
 * republication.
 */
export const SIMILARITY_THRESHOLD = 0.3;

/**
 * Fewest words either side must have before a verdict is meaningful.
 *
 * Measured by holding two genuinely different topics constant, sharing one
 * boilerplate sentence, and growing the unique body:
 *
 *   20 words  0.714      30 words  0.366      40 words  0.246
 *   25 words  0.484      35 words  0.294      50 words  0.185
 *
 * A shared stock sentence is a large fraction of a short draft and almost none
 * of a long one. The curve crosses the threshold at about 35 words; 40 is the
 * next round number with margin.
 */
export const MIN_COMPARABLE_WORDS = 40;

export interface ProposedOutput {
  readonly workspaceId: string;
  readonly kind: string;
  /** The `agent_outputs.content` jsonb value. Shape varies by `kind`. */
  readonly content: unknown;
}

export interface PriorOutput extends ProposedOutput {
  readonly id: string;
  /**
   * `agent_outputs.published_at`. NULL drafts are skipped — see
   * `selectComparable` for why that is a correctness requirement, not a filter
   * for convenience.
   */
  readonly publishedAt: Date | null;
}

export interface DuplicateMatch {
  readonly priorOutputId: string;
  readonly similarity: number;
  readonly kind: string;
}

/** Raised when the corpus contains another tenant's output. */
export class CrossWorkspaceCorpusError extends Error {
  constructor(expected: string, found: string, priorOutputId: string) {
    super(
      `Guardrail corpus contains output ${priorOutputId} from workspace ${found}, ` +
        `but the proposed output belongs to workspace ${expected}. ` +
        `Self-duplication is workspace-internal by definition.`,
    );
    this.name = 'CrossWorkspaceCorpusError';
  }
}

/**
 * The priors worth comparing against.
 *
 * ⚠️ UNPUBLISHED DRAFTS ARE EXCLUDED, AND THAT IS BACKWARDS-PROOFING, NOT A
 * SHORTCUT. A draft that was rejected or sent back for edits still sits in
 * `agent_outputs`. Comparing against it would flag the corrected version as a
 * duplicate of the thing it was corrected from — so the guardrail would fire
 * hardest exactly when a human had already done the right thing.
 */
export function selectComparable(
  proposed: ProposedOutput,
  priors: readonly PriorOutput[],
): PriorOutput[] {
  const comparable: PriorOutput[] = [];
  for (const prior of priors) {
    if (prior.workspaceId !== proposed.workspaceId) {
      throw new CrossWorkspaceCorpusError(proposed.workspaceId, prior.workspaceId, prior.id);
    }
    if (prior.publishedAt === null) continue;
    comparable.push(prior);
  }
  return comparable;
}

export interface SelfDuplicationResult {
  readonly verdict: 'pass' | 'fail' | 'indeterminate';
  /** Every prior at or above the threshold, worst first. */
  readonly matches: readonly DuplicateMatch[];
  /** Highest similarity seen against any comparable prior, threshold or not. */
  readonly highestSimilarity: number;
  /** Set when the verdict is `indeterminate`. */
  readonly reason?: string;
}

/**
 * Compare a proposed output against what this workspace already published.
 *
 * Deliberately does NOT filter by `kind`. Republishing a blog post as an email
 * is still republishing it, and a check that only compared like with like
 * would miss the cross-format case entirely.
 */
export function detectSelfDuplication(
  proposed: ProposedOutput,
  priors: readonly PriorOutput[],
): SelfDuplicationResult {
  const comparable = selectComparable(proposed, priors);

  const proposedWords = toWords(extractText(proposed.content));
  if (proposedWords.length < MIN_COMPARABLE_WORDS) {
    return {
      verdict: 'indeterminate',
      matches: [],
      highestSimilarity: 0,
      reason:
        `The proposed output has ${proposedWords.length} words; at least ` +
        `${MIN_COMPARABLE_WORDS} are needed for a similarity score to mean anything. ` +
        `Below that, shared boilerplate dominates the comparison.`,
    };
  }

  if (comparable.length === 0) {
    return {
      verdict: 'pass',
      matches: [],
      highestSimilarity: 0,
    };
  }

  const proposedPrint = fingerprint(proposed.content);
  const matches: DuplicateMatch[] = [];
  let highest = 0;
  let skippedForLength = 0;

  for (const prior of comparable) {
    // A short PRIOR is as untrustworthy a comparison as a short proposal.
    if (toWords(extractText(prior.content)).length < MIN_COMPARABLE_WORDS) {
      skippedForLength += 1;
      continue;
    }

    const similarity = jaccard(proposedPrint, fingerprint(prior.content));
    if (similarity > highest) highest = similarity;
    if (similarity >= SIMILARITY_THRESHOLD) {
      matches.push({ priorOutputId: prior.id, similarity, kind: prior.kind });
    }
  }

  if (matches.length === 0 && skippedForLength === comparable.length) {
    return {
      verdict: 'indeterminate',
      matches: [],
      highestSimilarity: highest,
      reason:
        `All ${comparable.length} published prior output(s) are shorter than ` +
        `${MIN_COMPARABLE_WORDS} words, so none could be compared meaningfully.`,
    };
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  return {
    verdict: matches.length > 0 ? 'fail' : 'pass',
    matches,
    highestSimilarity: highest,
  };
}
