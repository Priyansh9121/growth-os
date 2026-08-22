/**
 * The agent platform's closed value sets.
 *
 * These constants become native PostgreSQL enums, so a change here is a
 * migration there. The tests pin the properties that make that safe.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_STATUSES,
  APPROVAL_DECISIONS,
  ATTRIBUTION_OUTCOMES,
  type AgentRunStatus,
} from './enums';
import * as agents from './index';
import { AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from '../ai/tool';

describe('agent platform enums', () => {
  it.each([
    ['AGENT_RUN_STATUSES', AGENT_RUN_STATUSES],
    ['APPROVAL_DECISIONS', APPROVAL_DECISIONS],
    ['ATTRIBUTION_OUTCOMES', ATTRIBUTION_OUTCOMES],
  ])('%s has no duplicate values', (_name, values) => {
    // A duplicate reaches PostgreSQL as `CREATE TYPE ... AS ENUM` with a
    // repeated label, which is a migration that fails on apply rather than a
    // problem anyone sees here.
    expect(new Set(values).size).toBe(values.length);
  });

  it('a run is either in flight or finished — there is no third shape', () => {
    expect(AGENT_RUN_STATUSES).toEqual(['running', 'completed', 'failed']);
  });

  it('⚠️ `edited` is its own decision, not a flavour of `approved`', () => {
    // The distinction a future Brand-Voice agent trains on: "approved as
    // written" and "rewritten before approval" are different facts about the
    // agent that produced the draft.
    expect(APPROVAL_DECISIONS).toContain('edited');
    expect(APPROVAL_DECISIONS).toContain('approved');
    expect(new Set(APPROVAL_DECISIONS).size).toBe(3);
  });
});

/**
 * ⚠️ THE GUARD AGAINST A SECOND AUTONOMY VOCABULARY.
 *
 * `AutonomyLevel` (1–4) is defined in `../ai/tool.ts`, enforced as step 4 of
 * `invokeTool`'s guard chain, and documented in the architecture. The Phase 0
 * brief proposed a separate three-valued tier enum for `agent_outputs`; that
 * would have produced two answers to "may an AI do this without asking", only
 * one of which the guard chain reads.
 *
 * This is the same class of invariant as "URL identity is singular" (AGENTS.md
 * §5): the failure is not that either definition is wrong, it is that they can
 * disagree.
 *
 * @see docs/decisions/ADR-0063-agent-platform-data-model.md
 */
describe('⚠️ autonomy is defined once, in the AI tool contract', () => {
  it('the agents module exports no autonomy vocabulary of its own', () => {
    const exported = Object.keys(agents);
    const autonomyShaped = exported.filter((name) => /autonom|tier/i.test(name));
    expect(
      autonomyShaped,
      'the agent platform has started defining its own autonomy vocabulary — see ADR-0063',
    ).toEqual([]);
  });

  it('the levels the database CHECK constraint bounds are exactly these four', () => {
    // `agent_outputs.autonomy_level` is `smallint CHECK BETWEEN 1 AND 4`.
    // If a fifth level were added here the constraint would silently refuse it.
    expect(Object.values(AutonomyLevel).sort()).toEqual([1, 2, 3, 4]);
  });

  it('⚠️ the default is DRAFT_WITH_APPROVAL, which is what Phase 0 hardcodes', () => {
    // Every output this phase can produce is level 2. If this default ever
    // moves, the platform's safety posture moves with it — which is why the
    // column default and this constant are asserted against each other rather
    // than both being written down twice.
    expect(DEFAULT_AUTONOMY_LEVEL).toBe(AutonomyLevel.DRAFT_WITH_APPROVAL);
    expect(DEFAULT_AUTONOMY_LEVEL).toBe(2);
  });
});

describe('attribution outcomes compose with the CRM rather than restating it', () => {
  it('names CRM entities, never acquisition channels', () => {
    // ⚠️ The design rule from ADR-0012: channel provenance lives on
    // `acquisitions` and is NOT re-recorded here. An outcome named
    // `organic_search` would be a second, drifting copy of `source_type`.
    for (const outcome of ATTRIBUTION_OUTCOMES) {
      expect(outcome).toMatch(/^(contact|acquisition|opportunity)_/);
    }
  });

  it('every outcome is expressible as a row this platform can actually observe', () => {
    // Each maps to an existing CRM table. Nothing here anticipates a table
    // that does not exist, which is how a "build it to be queried" schema
    // turns into a guess.
    const observable: readonly AgentRunStatus[] = AGENT_RUN_STATUSES;
    expect(observable.length).toBeGreaterThan(0);
    expect(ATTRIBUTION_OUTCOMES).toHaveLength(5);
  });
});
