/**
 * The pipeline: how verdicts combine, and what the absence of a check means.
 */

import { describe, expect, it } from 'vitest';
import {
  PHASE_0_CHECKS,
  evaluateGuardrails,
  selfDuplicationCheck,
  type GuardrailCheck,
  type GuardrailInput,
} from './pipeline';
import type { PriorOutput, ProposedOutput } from './self-duplication';

const WORKSPACE = 'ws-abc-plumbing';

const ORIGINAL_BODY =
  'When your boiler fails in the middle of winter you need someone fast. Our Gas Safe engineers cover the whole of Leeds and are usually with you within two hours. We charge a flat callout fee with no hidden extras, and we will always quote before starting work.';

const proposed: ProposedOutput = {
  workspaceId: WORKSPACE,
  kind: 'blog_post',
  content: { body: ORIGINAL_BODY },
};

const publishedPrior: PriorOutput = {
  id: 'out-1',
  workspaceId: WORKSPACE,
  kind: 'blog_post',
  content: { body: ORIGINAL_BODY },
  publishedAt: new Date('2026-03-01T00:00:00Z'),
};

const check = (name: string, outcome: 'fail' | 'indeterminate' | null): GuardrailCheck => ({
  name,
  run: () =>
    outcome === null ? [] : [{ check: name, outcome, message: `${name} says ${outcome}` }],
});

describe('evaluateGuardrails', () => {
  it('a clean draft passes with no findings', () => {
    const report = evaluateGuardrails({ proposed, priors: [] });
    expect(report.outcome).toBe('pass');
    expect(report.findings).toEqual([]);
  });

  it('a republication fails, with a reason a reviewer can read', () => {
    const report = evaluateGuardrails({ proposed, priors: [publishedPrior] });
    expect(report.outcome).toBe('fail');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.check).toBe('self-duplication');
    expect(report.findings[0]?.message).toContain('out-1');
    expect(report.findings[0]?.message).toMatch(/100% similar/);
  });

  it('the finding carries machine-readable matches for a UI to link', () => {
    const report = evaluateGuardrails({ proposed, priors: [publishedPrior] });
    const details = report.findings[0]?.details as { matches: Array<{ priorOutputId: string }> };
    expect(details.matches[0]?.priorOutputId).toBe('out-1');
  });

  describe('⚠️ combining verdicts', () => {
    const input: GuardrailInput = { proposed, priors: [] };

    it('fail outranks indeterminate', () => {
      // The objection that was PROVEN beats the one that could not be.
      const report = evaluateGuardrails(input, [check('a', 'indeterminate'), check('b', 'fail')]);
      expect(report.outcome).toBe('fail');
      expect(report.findings).toHaveLength(2);
    });

    it('indeterminate outranks pass', () => {
      const report = evaluateGuardrails(input, [check('a', null), check('b', 'indeterminate')]);
      expect(report.outcome).toBe('indeterminate');
    });

    it('all checks run — the first failure does not short-circuit the rest', () => {
      // A reviewer wants every objection at once, not the first one found.
      const report = evaluateGuardrails(input, [
        check('a', 'fail'),
        check('b', 'fail'),
        check('c', 'indeterminate'),
      ]);
      expect(report.findings.map((f) => f.check)).toEqual(['a', 'b', 'c']);
    });

    it('no checks at all is a pass, which is why an empty roster would be dangerous', () => {
      // Documented rather than defended against: this is exactly why the
      // unimplemented checks are ABSENT rather than stubbed to return pass.
      expect(evaluateGuardrails(input, []).outcome).toBe('pass');
    });
  });
});

describe('⚠️ Phase 0 ships exactly one check', () => {
  it('the roster is self-duplication and nothing else', () => {
    // ToS/rate-limit and disclosure checks are named in the module header as
    // deliberately unimplemented. If someone adds a placeholder that always
    // passes, this fails and forces the conversation.
    expect(PHASE_0_CHECKS).toHaveLength(1);
    expect(PHASE_0_CHECKS[0]).toBe(selfDuplicationCheck);
    expect(PHASE_0_CHECKS[0]?.name).toBe('self-duplication');
  });

  it('a cross-workspace corpus propagates rather than being swallowed', () => {
    // The pipeline must not convert a tenancy error into a finding: a finding
    // reads as "we checked and found something", which is not what happened.
    expect(() =>
      evaluateGuardrails({
        proposed,
        priors: [{ ...publishedPrior, workspaceId: 'ws-someone-else' }],
      }),
    ).toThrow(/workspace/i);
  });
});
