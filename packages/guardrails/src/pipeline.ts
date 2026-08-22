/**
 * The guardrail pipeline — one entry point, a list of checks, one report.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * A caller asks one question — "is this draft safe to put in front of a
 * human?" — and gets one answer plus the reasons behind it. Checks are
 * independent and all of them run: stopping at the first failure would hide
 * the second reason, and a reviewer wants every objection at once.
 *
 * ⚠️ ONE CHECK EXISTS. THE OTHERS ARE NAMED, NOT STUBBED.
 * The Phase 0 brief listed platform ToS / rate-limit rules and disclosure
 * compliance alongside self-duplication. Neither is implemented, and neither
 * is a placeholder returning `pass` — an empty check that always passes is
 * indistinguishable from a check that works, which is the exact failure mode
 * `verify-boundaries.mjs` exists to prevent elsewhere in this repository.
 *
 * They are absent because they cannot be written yet:
 *
 *   Platform ToS and rate limits are per-connector facts. "How many posts per
 *   day may this account make" has no answer until there is a connector with a
 *   platform behind it, and inventing a shape now would bake in a guess that
 *   the first real connector would have to break.
 *
 *   Disclosure compliance ("this was AI-assisted") depends on jurisdiction and
 *   on the channel, and the product has settled neither.
 *
 * `GuardrailCheck` is the seam they slot into. That is the whole commitment
 * this phase makes about them.
 *
 * @see docs/decisions/ADR-0064-self-duplication-guardrail.md
 */

import {
  detectSelfDuplication,
  type PriorOutput,
  type ProposedOutput,
  type SelfDuplicationResult,
} from './self-duplication';

/**
 * `pass` — nothing objected.
 * `fail` — at least one check objected, with reasons.
 * `indeterminate` — no check objected, but at least one could not decide.
 *
 * ⚠️ `indeterminate` IS NOT `pass`. A caller that treats them the same has
 * turned "I could not tell" into "I checked and it is fine", which is the one
 * translation this type exists to prevent.
 */
export type GuardrailOutcome = 'pass' | 'fail' | 'indeterminate';

export interface GuardrailFinding {
  /** Which check produced this. */
  readonly check: string;
  readonly outcome: Exclude<GuardrailOutcome, 'pass'>;
  /** Human-readable, and intended to be shown to the reviewer verbatim. */
  readonly message: string;
  /** Machine-readable specifics, for a UI that wants to link to the prior. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface GuardrailReport {
  readonly outcome: GuardrailOutcome;
  readonly findings: readonly GuardrailFinding[];
}

export interface GuardrailInput {
  readonly proposed: ProposedOutput;
  /**
   * The workspace's own prior outputs. The caller fetches these; this package
   * opens no socket and touches no database (see the package description).
   */
  readonly priors: readonly PriorOutput[];
}

export interface GuardrailCheck {
  readonly name: string;
  readonly run: (input: GuardrailInput) => readonly GuardrailFinding[];
}

function describeMatches(result: SelfDuplicationResult): string {
  const worst = result.matches[0];
  if (!worst) return 'Near-duplicate of previously published output.';
  const percent = (worst.similarity * 100).toFixed(0);
  const others =
    result.matches.length > 1
      ? ` (and ${result.matches.length - 1} other published output(s))`
      : '';
  return (
    `This draft is ${percent}% similar to already-published output ` +
    `${worst.priorOutputId}${others}. Publishing both would compete with itself.`
  );
}

export const selfDuplicationCheck: GuardrailCheck = {
  name: 'self-duplication',
  run: ({ proposed, priors }) => {
    const result = detectSelfDuplication(proposed, priors);

    if (result.verdict === 'fail') {
      return [
        {
          check: 'self-duplication',
          outcome: 'fail',
          message: describeMatches(result),
          details: {
            matches: result.matches,
            highestSimilarity: result.highestSimilarity,
          },
        },
      ];
    }

    if (result.verdict === 'indeterminate') {
      return [
        {
          check: 'self-duplication',
          outcome: 'indeterminate',
          message: result.reason ?? 'Could not compare this draft.',
          details: { highestSimilarity: result.highestSimilarity },
        },
      ];
    }

    return [];
  },
};

/** Everything that runs in Phase 0. Exactly one check, deliberately. */
export const PHASE_0_CHECKS: readonly GuardrailCheck[] = [selfDuplicationCheck];

/**
 * Run every check and combine the verdicts.
 *
 * `fail` outranks `indeterminate`, which outranks `pass`. A draft that both
 * duplicates something and could not be fully assessed is a `fail` — the
 * objection that was proven beats the one that could not be.
 */
export function evaluateGuardrails(
  input: GuardrailInput,
  checks: readonly GuardrailCheck[] = PHASE_0_CHECKS,
): GuardrailReport {
  const findings = checks.flatMap((check) => [...check.run(input)]);

  const outcome: GuardrailOutcome = findings.some((f) => f.outcome === 'fail')
    ? 'fail'
    : findings.some((f) => f.outcome === 'indeterminate')
      ? 'indeterminate'
      : 'pass';

  return { outcome, findings };
}
