/**
 * Self-duplication detection.
 *
 * ⚠️ THE FIXTURES ARE THE CALIBRATION CORPUS.
 * The constants in `self-duplication.ts` were chosen by measuring these exact
 * documents, so these tests are not illustrations of the thresholds — they are
 * the measurements that produced them, pinned. If someone moves
 * `SIMILARITY_THRESHOLD`, the case that sits nearest the boundary fails and
 * says which direction it moved.
 */

import { describe, expect, it } from 'vitest';
import {
  CrossWorkspaceCorpusError,
  MIN_COMPARABLE_WORDS,
  SIMILARITY_THRESHOLD,
  detectSelfDuplication,
  selectComparable,
  type PriorOutput,
  type ProposedOutput,
} from './self-duplication';

const WORKSPACE = 'ws-abc-plumbing';
const OTHER_WORKSPACE = 'ws-meridian-legal';

const ORIGINAL_BODY =
  'When your boiler fails in the middle of winter you need someone fast. Our Gas Safe engineers cover the whole of Leeds and are usually with you within two hours. We charge a flat callout fee with no hidden extras, and we will always quote before starting work.';

function proposed(content: unknown): ProposedOutput {
  return { workspaceId: WORKSPACE, kind: 'blog_post', content };
}

function prior(id: string, content: unknown, overrides: Partial<PriorOutput> = {}): PriorOutput {
  return {
    id,
    workspaceId: WORKSPACE,
    kind: 'blog_post',
    content,
    publishedAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

const PUBLISHED_ORIGINAL = prior('out-1', {
  title: 'Emergency boiler repair in Leeds',
  body: ORIGINAL_BODY,
});

describe('⚠️ workspace isolation is structural, not a filter', () => {
  it('a prior from another workspace THROWS rather than being skipped', () => {
    // Quietly filtering it would turn a tenancy bug into a check that simply
    // finds nothing — the failure would look like a clean pass.
    expect(() =>
      detectSelfDuplication(proposed({ body: ORIGINAL_BODY }), [
        prior('out-x', { body: ORIGINAL_BODY }, { workspaceId: OTHER_WORKSPACE }),
      ]),
    ).toThrow(CrossWorkspaceCorpusError);
  });

  it('the error names the offending output and both workspaces', () => {
    try {
      selectComparable(proposed({ body: ORIGINAL_BODY }), [
        prior('out-leak', { body: 'x' }, { workspaceId: OTHER_WORKSPACE }),
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CrossWorkspaceCorpusError);
      expect((error as Error).message).toContain('out-leak');
      expect((error as Error).message).toContain(OTHER_WORKSPACE);
      expect((error as Error).message).toContain(WORKSPACE);
    }
  });

  it('it throws even when the foreign output would not have matched anyway', () => {
    // The check is on the corpus, not on the result. A tenancy violation that
    // happens to be harmless is still a tenancy violation.
    expect(() =>
      selectComparable(proposed({ body: ORIGINAL_BODY }), [
        prior('out-y', { body: 'completely unrelated text' }, { workspaceId: OTHER_WORKSPACE }),
      ]),
    ).toThrow(CrossWorkspaceCorpusError);
  });
});

describe('⚠️ unpublished priors are excluded', () => {
  it('a rejected draft does not make its own correction look like a duplicate', () => {
    // The guardrail would otherwise fire hardest exactly when a human had
    // already done the right thing and sent a draft back for edits.
    const result = detectSelfDuplication(proposed({ body: ORIGINAL_BODY }), [
      prior('out-draft', { body: ORIGINAL_BODY }, { publishedAt: null }),
    ]);
    expect(result.verdict).toBe('pass');
    expect(result.matches).toEqual([]);
  });

  it('selectComparable keeps published and drops unpublished', () => {
    const comparable = selectComparable(proposed({ body: ORIGINAL_BODY }), [
      PUBLISHED_ORIGINAL,
      prior('out-draft', { body: 'x' }, { publishedAt: null }),
    ]);
    expect(comparable.map((p) => p.id)).toEqual(['out-1']);
  });
});

describe('detects republication', () => {
  it('an identical draft fails', () => {
    const result = detectSelfDuplication(
      proposed({ title: 'Emergency boiler repair in Leeds', body: ORIGINAL_BODY }),
      [PUBLISHED_ORIGINAL],
    );
    expect(result.verdict).toBe('fail');
    expect(result.highestSimilarity).toBe(1);
    expect(result.matches[0]?.priorOutputId).toBe('out-1');
  });

  it('recasing and repunctuating does not evade it', () => {
    const result = detectSelfDuplication(
      proposed({
        title: 'EMERGENCY BOILER REPAIR IN LEEDS!!',
        body: ORIGINAL_BODY.toUpperCase().replace(/\./g, '!'),
      }),
      [PUBLISHED_ORIGINAL],
    );
    expect(result.verdict).toBe('fail');
  });

  it('splitting the same prose across different fields does not evade it', () => {
    const sentences = ORIGINAL_BODY.split('. ');
    const result = detectSelfDuplication(
      proposed({
        heading: 'Emergency boiler repair in Leeds',
        para1: sentences[0],
        para2: sentences[1],
        para3: sentences[2],
      }),
      [PUBLISHED_ORIGINAL],
    );
    expect(result.verdict).toBe('fail');
    expect(result.highestSimilarity).toBeGreaterThan(0.9);
  });

  it('appending a paragraph to a republication does not evade it', () => {
    const result = detectSelfDuplication(
      proposed({
        title: 'Emergency boiler repair in Leeds',
        body: ORIGINAL_BODY,
        extra:
          'We also service landlord gas safety certificates and can usually fit these around your tenants.',
      }),
      [PUBLISHED_ORIGINAL],
    );
    expect(result.verdict).toBe('fail');
    expect(result.highestSimilarity).toBeGreaterThan(SIMILARITY_THRESHOLD);
  });

  it('⚠️ light rewording is still caught — this is the case nearest the threshold', () => {
    // Measured at 0.384 against a 0.30 threshold. If the threshold is raised
    // above 0.384 this fails, which is the point: it is the boundary case.
    const result = detectSelfDuplication(
      proposed({
        title: 'Urgent boiler repairs in Leeds',
        body: 'When your boiler breaks in the middle of winter you need someone quickly. Our Gas Safe engineers cover all of Leeds and are normally with you within two hours. We charge a fixed callout fee with no hidden extras, and we will always quote before beginning work.',
      }),
      [PUBLISHED_ORIGINAL],
    );
    expect(result.verdict).toBe('fail');
    expect(result.highestSimilarity).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    expect(result.highestSimilarity).toBeLessThan(0.5);
  });

  it('reports every match, worst first', () => {
    const result = detectSelfDuplication(proposed({ body: ORIGINAL_BODY }), [
      prior('out-close', { body: ORIGINAL_BODY.replace('flat', 'fixed') }),
      prior('out-exact', { body: ORIGINAL_BODY }),
    ]);
    expect(result.verdict).toBe('fail');
    expect(result.matches.length).toBe(2);
    expect(result.matches[0]!.priorOutputId).toBe('out-exact');
    expect(result.matches[0]!.similarity).toBeGreaterThanOrEqual(result.matches[1]!.similarity);
  });

  it('cross-format republication is caught — kind is deliberately not filtered', () => {
    // Republishing a blog post as an email is still republishing it.
    const result = detectSelfDuplication(
      { workspaceId: WORKSPACE, kind: 'email', content: { body: ORIGINAL_BODY } },
      [prior('out-blog', { body: ORIGINAL_BODY }, { kind: 'blog_post' })],
    );
    expect(result.verdict).toBe('fail');
    expect(result.matches[0]?.kind).toBe('blog_post');
  });
});

describe('does not fire on genuinely new content', () => {
  it('a heavy rewrite on the same topic passes', () => {
    const result = detectSelfDuplication(
      proposed({
        title: 'Leeds boiler breakdowns, sorted the same day',
        body: 'A cold house is not something to put up with. We are Gas Safe registered, we work across Leeds, and most customers see an engineer inside two hours. Pricing is one flat fee for the visit, and nothing starts until you have agreed the quote.',
      }),
      [PUBLISHED_ORIGINAL],
    );
    expect(result.verdict).toBe('pass');
  });

  it('⚠️ different topics sharing trade boilerplate pass — the false-positive case', () => {
    // Both drafts contain the same stock sentence. Measured at 0.246 for
    // documents of this length, below the 0.30 threshold.
    // ⚠️ Both sides are deliberately over MIN_COMPARABLE_WORDS. An earlier
    // draft of this fixture had the prior at 39 words and the check correctly
    // returned `indeterminate` — the false-positive claim is only meaningful
    // in the length regime where a verdict is given at all.
    const boiler =
      'Gas Safe registered engineers, no hidden extras, and a fixed price agreed before we start.';
    const result = detectSelfDuplication(
      proposed({
        body: `Emergency boiler repair in Leeds. ${boiler} When the heating dies on the coldest night of the year, waiting three days for an appointment is not an option. We keep evening and weekend slots open for exactly this, and most call-outs are diagnosed within the hour.`,
      }),
      [
        prior('out-service', {
          body: `Annual boiler servicing in Leeds. ${boiler} A yearly inspection keeps your manufacturer warranty valid and catches worn parts long before they strand you without heating for a week in January.`,
        }),
      ],
    );
    expect(result.verdict).toBe('pass');
    expect(result.highestSimilarity).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('an empty corpus passes', () => {
    expect(detectSelfDuplication(proposed({ body: ORIGINAL_BODY }), []).verdict).toBe('pass');
  });
});

describe('⚠️ indeterminate is not pass', () => {
  it('a draft shorter than MIN_COMPARABLE_WORDS cannot be judged', () => {
    // Two different 20-word drafts sharing boilerplate measured 0.714 —
    // higher than a real republication. A verdict here would be a coin flip.
    const result = detectSelfDuplication(proposed({ body: 'Short headline about boilers' }), [
      PUBLISHED_ORIGINAL,
    ]);
    expect(result.verdict).toBe('indeterminate');
    expect(result.reason).toContain(String(MIN_COMPARABLE_WORDS));
  });

  it('an identical SHORT draft is still indeterminate, not fail', () => {
    // Uncomfortable but correct: the check reports that it cannot tell rather
    // than being right by luck at a length where it is usually wrong.
    const short = { body: 'Emergency boiler repair in Leeds today' };
    const result = detectSelfDuplication(proposed(short), [prior('out-short', short)]);
    expect(result.verdict).toBe('indeterminate');
  });

  it('when every published prior is too short, the verdict is indeterminate', () => {
    const result = detectSelfDuplication(proposed({ body: ORIGINAL_BODY }), [
      prior('out-tiny', { body: 'Call us today for boilers' }),
    ]);
    expect(result.verdict).toBe('indeterminate');
    expect(result.reason).toContain('shorter than');
  });

  it('a mix of short and long priors still yields a real verdict', () => {
    const result = detectSelfDuplication(proposed({ body: ORIGINAL_BODY }), [
      prior('out-tiny', { body: 'Call us today' }),
      PUBLISHED_ORIGINAL,
    ]);
    expect(result.verdict).toBe('fail');
  });

  it('empty content is indeterminate rather than a duplicate of other empty content', () => {
    const result = detectSelfDuplication(proposed({}), [prior('out-empty', {})]);
    expect(result.verdict).toBe('indeterminate');
  });
});

describe('hostile input', () => {
  it('a cyclic content object does not crash the check', () => {
    const cyclic: Record<string, unknown> = { body: ORIGINAL_BODY };
    cyclic['self'] = cyclic;
    expect(() => detectSelfDuplication(proposed(cyclic), [PUBLISHED_ORIGINAL])).not.toThrow();
  });

  it('a cyclic PRIOR does not crash the check either', () => {
    const cyclic: Record<string, unknown> = { body: ORIGINAL_BODY };
    cyclic['self'] = cyclic;
    expect(() =>
      detectSelfDuplication(proposed({ body: ORIGINAL_BODY }), [prior('out-cyc', cyclic)]),
    ).not.toThrow();
  });

  it('null and non-object content are handled', () => {
    expect(detectSelfDuplication(proposed(null), [PUBLISHED_ORIGINAL]).verdict).toBe(
      'indeterminate',
    );
    expect(detectSelfDuplication(proposed(42), [PUBLISHED_ORIGINAL]).verdict).toBe('indeterminate');
  });

  it('a very large content object completes', () => {
    const huge = { body: ORIGINAL_BODY, filler: 'lorem ipsum '.repeat(50_000) };
    expect(() => detectSelfDuplication(proposed(huge), [PUBLISHED_ORIGINAL])).not.toThrow();
  });
});
