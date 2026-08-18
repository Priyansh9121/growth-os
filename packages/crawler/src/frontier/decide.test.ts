/**
 * The enqueue decision — where six rules compose.
 *
 * WHY THIS SUITE IS EXHAUSTIVE RATHER THAN REPRESENTATIVE
 * Normalisation, scope, robots, depth, the fetch budget and the row ceiling all
 * meet here, and composition is where the interesting bugs live. Each rule was
 * tested in isolation elsewhere; nothing until now has asserted what happens
 * when two of them disagree about the same URL.
 *
 * The ORDER of the checks is asserted deliberately. It is a design decision —
 * an out-of-scope URL must not have its robots rules consulted, because
 * consulting them would mean fetching a third party's robots.txt.
 */

import { describe, expect, it } from 'vitest';
import {
  decideEnqueue,
  FRONTIER_ROWS_CAP,
  FRONTIER_ROWS_FLOOR,
  frontierRowCeiling,
  terminationReason,
  type Candidate,
  type DecideInput,
} from './decide';
import { MAX_URL_LENGTH } from '@growth-os/net';
import { SKIP_REASONS, SKIP_REASON_LABELS } from '@growth-os/contracts';
import { parseRobotsTxt, ALLOW_ALL } from '../robots/parse';
import { crawlScope } from '../urls/scope';

const SCOPE = crawlScope('https://example.test');

function input(overrides: Partial<DecideInput> & { candidate: Candidate }): DecideInput {
  return {
    scope: SCOPE,
    robots: ALLOW_ALL,
    siteDisallowed: false,
    budget: { pageLimit: 500, maxDepth: 10, maxRows: 5000 },
    counts: { rows: 0, fetchable: 0 },
    ...overrides,
  };
}

const candidate = (url: string, depth = 1): Candidate => ({ url, depth, source: 'link' });

describe('decideEnqueue — accepting', () => {
  it('accepts an in-scope, allowed URL and returns its normalised identity', () => {
    const decision = decideEnqueue(input({ candidate: candidate('https://example.test/about') }));

    expect(decision.accept).toBe(true);
    if (decision.accept) {
      expect(decision.normalisedUrl).toBe('https://example.test/about');
      expect(decision.depth).toBe(1);
    }
  });

  it('⚠️ normalises through the one definition, never inline', () => {
    // Two spellings of one page must reach the same identity, or the frontier's
    // uniqueness constraint is comparing the wrong strings.
    const a = decideEnqueue(
      input({ candidate: candidate('https://EXAMPLE.test/a?utm_source=x#frag') }),
    );
    const b = decideEnqueue(input({ candidate: candidate('https://example.test:443/a') }));

    expect(a.accept && b.accept).toBe(true);
    expect(a.normalisedUrl).toBe(b.normalisedUrl);
    expect(a.normalisedUrl).toBe('https://example.test/a');
  });

  it('resolves a relative href against the page it was found on', () => {
    const decision = decideEnqueue(
      input({
        candidate: {
          url: '../contact',
          base: 'https://example.test/a/b',
          depth: 2,
          source: 'link',
        },
      }),
    );
    expect(decision.accept && decision.normalisedUrl).toBe('https://example.test/contact');
  });

  it('accepts the http → https upgrade of its own host', () => {
    const decision = decideEnqueue(
      input({
        scope: crawlScope('http://example.test'),
        candidate: candidate('https://example.test/'),
      }),
    );
    expect(decision.accept).toBe(true);
  });
});

describe('decideEnqueue — refusing, with the reason recorded', () => {
  it.each([
    ['mailto:sam@example.test', 'unsupported_scheme'],
    ['tel:+61400000000', 'unsupported_scheme'],
    ['javascript:void(0)', 'unsupported_scheme'],
    ['#section', 'unsupported_scheme'],
    ['https://facebook.test/abc', 'external'],
    ['https://blog.example.test/x', 'other_subdomain'],
  ] as const)('%s → %s', (url, reason) => {
    const decision = decideEnqueue(input({ candidate: candidate(url) }));
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.skipReason).toBe(reason);
  });

  it('⚠️ records a refused URL rather than dropping it silently', () => {
    // "We found 900 URLs and fetched 500" is a different fact from "the site has
    // 500 pages". A crawler that dropped the difference would report the second
    // while meaning the first.
    const decision = decideEnqueue(input({ candidate: candidate('https://other.test/x') }));
    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.normalisedUrl).toBe('https://other.test/x');
      expect(decision.unrecordable).toBe(false);
    }
  });

  it('keeps no normalised URL for something that was never a URL', () => {
    const decision = decideEnqueue(input({ candidate: candidate('mailto:x@y.test') }));
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.normalisedUrl).toBeNull();
  });
});

describe('robots is consulted BEFORE enqueueing', () => {
  const robots = parseRobotsTxt('User-agent: *\nDisallow: /admin\nAllow: /admin/public');

  it('a disallowed URL never enters the frontier, and the rule is recorded', () => {
    const decision = decideEnqueue(
      input({ candidate: candidate('https://example.test/admin/x'), robots }),
    );

    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.skipReason).toBe('robots_disallowed');
      // ⚠️ The deciding line, verbatim from the operator's own file. A fact.
      expect(decision.rule).toBe('Disallow: /admin');
    }
  });

  it('honours an Allow that beats the Disallow on length', () => {
    const decision = decideEnqueue(
      input({ candidate: candidate('https://example.test/admin/public/x'), robots }),
    );
    expect(decision.accept).toBe(true);
  });

  it('⚠️ records no rule when the whole site is fail-closed', () => {
    // robots.txt could not be read (ADR-0035). There is no line to quote, and
    // quoting one the site never wrote would be worse than saying nothing.
    const decision = decideEnqueue(
      input({ candidate: candidate('https://example.test/a'), siteDisallowed: true }),
    );

    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.skipReason).toBe('robots_disallowed');
      expect(decision.rule).toBeNull();
    }
  });

  it('records a fact, never a judgement (§5)', () => {
    const decision = decideEnqueue(
      input({ candidate: candidate('https://example.test/admin'), robots }),
    );
    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(Object.keys(decision).sort()).toEqual([
        'accept',
        'normalisedUrl',
        'rule',
        'skipReason',
        'unrecordable',
      ]);
    }
  });
});

describe('⚠️ the order of the checks is the design', () => {
  const denyAll = parseRobotsTxt('User-agent: *\nDisallow: /');

  it('an out-of-scope URL is refused for SCOPE, not for robots', () => {
    // Consulting robots for a third party's URL would mean fetching THEIR
    // robots.txt — a request scope exists to prevent.
    const decision = decideEnqueue(
      input({ candidate: candidate('https://other.test/x'), robots: denyAll }),
    );
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.skipReason).toBe('external');
  });

  it('a non-URL is refused before scope is consulted', () => {
    const decision = decideEnqueue(
      input({ candidate: candidate('mailto:x@other.test'), robots: denyAll }),
    );
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.skipReason).toBe('unsupported_scheme');
  });

  it('depth is refused before robots, because the answer changes nothing', () => {
    const decision = decideEnqueue(
      input({
        candidate: candidate('https://example.test/deep', 11),
        robots: denyAll,
        budget: { pageLimit: 500, maxDepth: 10, maxRows: 5000 },
      }),
    );
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.skipReason).toBe('depth_limit');
  });

  it('robots is refused before the budget', () => {
    // A disallowed URL must not be reported as "we ran out of budget", which
    // would tell the operator to raise a limit that would change nothing.
    const decision = decideEnqueue(
      input({
        candidate: candidate('https://example.test/x'),
        robots: denyAll,
        counts: { rows: 0, fetchable: 500 },
      }),
    );
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.skipReason).toBe('robots_disallowed');
  });
});

describe('depth', () => {
  it('accepts at exactly the limit and refuses past it', () => {
    const budget = { pageLimit: 500, maxDepth: 3, maxRows: 5000 };
    expect(
      decideEnqueue(input({ candidate: candidate('https://example.test/a', 3), budget })).accept,
    ).toBe(true);
    expect(
      decideEnqueue(input({ candidate: candidate('https://example.test/a', 4), budget })).accept,
    ).toBe(false);
  });
});

describe('⚠️ pageLimit counts pages FETCHED, not URLs discovered (ADR-0036)', () => {
  const budget = { pageLimit: 2, maxDepth: 10, maxRows: 5000 };

  it('a skipped URL does not consume the budget', () => {
    // The reading that matters. A site with 400 external links would otherwise
    // get a fraction of the crawl it configured, and the number would mean
    // something different for every site — useless as a budget.
    const afterManySkips = { rows: 400, fetchable: 0 };
    const decision = decideEnqueue(
      input({ candidate: candidate('https://example.test/a'), budget, counts: afterManySkips }),
    );
    expect(decision.accept).toBe(true);
  });

  it('refuses once the FETCHABLE count reaches the limit', () => {
    const decision = decideEnqueue(
      input({
        candidate: candidate('https://example.test/a'),
        budget,
        counts: { rows: 10, fetchable: 2 },
      }),
    );
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.skipReason).toBe('page_limit');
  });
});

describe('the row ceiling', () => {
  it('refuses an otherwise-acceptable URL, and says it cannot be recorded', () => {
    const decision = decideEnqueue(
      input({
        candidate: candidate('https://example.test/a'),
        budget: { pageLimit: 500, maxDepth: 10, maxRows: 100 },
        counts: { rows: 100, fetchable: 0 },
      }),
    );

    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.unrecordable).toBe(true);
  });

  it('marks a REFUSAL unrecordable too, past the ceiling', () => {
    // Even a refusal needs a row. Past the ceiling the honest report is
    // "discovery was truncated", not a silently shorter list.
    const decision = decideEnqueue(
      input({
        candidate: candidate('https://other.test/x'),
        budget: { pageLimit: 500, maxDepth: 10, maxRows: 50 },
        counts: { rows: 50, fetchable: 0 },
      }),
    );
    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.skipReason).toBe('external');
      expect(decision.unrecordable).toBe(true);
    }
  });
});

describe('frontierRowCeiling', () => {
  it.each([
    [1, FRONTIER_ROWS_FLOOR],
    [10, FRONTIER_ROWS_FLOOR],
    [50, FRONTIER_ROWS_FLOOR],
    [100, 1_000],
    [500, 5_000],
    [1_000, 10_000],
    [2_000, FRONTIER_ROWS_CAP],
    [10_000, FRONTIER_ROWS_CAP],
  ])('pageLimit %i → %i rows', (pageLimit, expected) => {
    expect(frontierRowCeiling(pageLimit)).toBe(expected);
  });

  it('is always at least the page limit, so the fetchable set is never starved', () => {
    // The property that matters: the ceiling must never be the thing that stops
    // a crawl reaching its configured page count.
    for (const pageLimit of [1, 10, 100, 500, 1_000, 5_000, 10_000]) {
      expect(frontierRowCeiling(pageLimit)).toBeGreaterThanOrEqual(pageLimit);
    }
  });

  it('is monotonic in the page limit', () => {
    const limits = [1, 10, 100, 500, 1_000, 2_000, 10_000];
    const ceilings = limits.map(frontierRowCeiling);
    expect(ceilings).toEqual([...ceilings].sort((a, b) => a - b));
  });
});

describe('terminationReason — all four conditions', () => {
  const base = {
    cancelRequested: false,
    queued: 5,
    fetchable: 0,
    pageLimit: 500,
    skippedForDepth: false,
  };

  it('continues while there is work and budget', () => {
    expect(terminationReason(base)).toBeNull();
  });

  it('budget_exhausted when the fetch count reaches the limit', () => {
    expect(terminationReason({ ...base, fetchable: 500 })).toBe('budget_exhausted');
  });

  it('frontier_empty when nothing is queued and depth was never the reason', () => {
    expect(terminationReason({ ...base, queued: 0 })).toBe('frontier_empty');
  });

  it('⚠️ depth_exhausted is distinguishable from frontier_empty', () => {
    // Both stop the loop by running out of work. Only one is a reason to raise
    // a setting, and collapsing them would lose that.
    expect(terminationReason({ ...base, queued: 0, skippedForDepth: true })).toBe(
      'depth_exhausted',
    );
  });

  it('cancelled', () => {
    expect(terminationReason({ ...base, cancelRequested: true })).toBe('cancelled');
  });

  it('⚠️ cancellation wins over every other reason', () => {
    // A cancelled crawl that also exhausted its budget is CANCELLED. That is
    // what the operator did, and reporting "completed" because the arithmetic
    // also worked out would be a lie about who decided.
    expect(
      terminationReason({
        cancelRequested: true,
        queued: 0,
        fetchable: 500,
        pageLimit: 500,
        skippedForDepth: true,
      }),
    ).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// §5 the two reasons the frontier row could not express — see ADR-0042
// ---------------------------------------------------------------------------

describe('⚠️ url_too_long — an over-length URL is not "not a web page"', () => {
  const overLength = `https://example.test/${'a'.repeat(MAX_URL_LENGTH)}`;

  it('records url_too_long, not unsupported_scheme', () => {
    // ADR-0038 capped the URL in normaliseUrl and recorded the reason as
    // unsupported_scheme — the label every normaliseUrl → null gets. It says
    // "this is a mailto:" about a URL that is an ordinary page, too long.
    const decision = decideEnqueue(input({ candidate: candidate(overLength) }));

    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.skipReason).toBe('url_too_long');
      expect(decision.normalisedUrl).toBeNull();
    }
  });

  it('⚠️ still records unsupported_scheme for things that are not resources', () => {
    // The distinction is the whole point: these must NOT be relabelled.
    for (const url of ['mailto:sam@example.test', 'tel:+61400000000', 'javascript:void(0)']) {
      const decision = decideEnqueue(input({ candidate: candidate(url) }));
      expect(decision.accept).toBe(false);
      if (!decision.accept) expect(decision.skipReason, url).toBe('unsupported_scheme');
    }
  });

  it('⚠️ catches a URL that only exceeds the ceiling AFTER normalising', () => {
    // ADR-0038 measured `+` → `%20` growing a query 2.98×, so an input under
    // the ceiling can produce an identity over it. That path returns null from
    // the second check, and it must carry the same reason as the first.
    const grows = `https://example.test/s?q=${'+'.repeat(900)}`;
    expect(grows.length).toBeLessThan(MAX_URL_LENGTH);

    const decision = decideEnqueue(input({ candidate: candidate(grows) }));
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.skipReason).toBe('url_too_long');
  });

  it('exactly at the ceiling is still accepted', () => {
    const atCap = `https://example.test/${'a'.repeat(MAX_URL_LENGTH - 'https://example.test/'.length)}`;
    expect(atCap.length).toBe(MAX_URL_LENGTH);
    expect(decideEnqueue(input({ candidate: candidate(atCap) })).accept).toBe(true);
  });
});

describe('⚠️ budget_exhausted — our limit, not a rule the operator wrote', () => {
  /** The pattern ADR-0039 measured at 1,049,601 steps against a 2,048 target. */
  const hostileRobots = parseRobotsTxt(`User-agent: *\nDisallow: /*${'a'.repeat(1023)}b\n`);
  const atCeiling = `https://example.test/${'a'.repeat(MAX_URL_LENGTH - 'https://example.test/'.length)}`;

  it('records budget_exhausted rather than robots_disallowed', () => {
    // The RobotsVerdict already knew. The frontier row could not say it, so an
    // operator asking "why was this skipped?" was told a rule they wrote
    // decided it. It did not; our step budget did.
    const decision = decideEnqueue(
      input({ candidate: candidate(atCeiling), robots: hostileRobots }),
    );

    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.skipReason).toBe('budget_exhausted');
      // The pattern is still quoted verbatim — it is the fact being reported.
      expect(decision.rule).toContain('Disallow: /*');
    }
  });

  it('⚠️ an ordinary robots refusal is still robots_disallowed', () => {
    const decision = decideEnqueue(
      input({
        candidate: candidate('https://example.test/admin/customers'),
        robots: parseRobotsTxt('User-agent: *\nDisallow: /admin'),
      }),
    );

    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.skipReason).toBe('robots_disallowed');
      expect(decision.rule).toBe('Disallow: /admin');
    }
  });

  it('⚠️ a site-wide refusal is still robots_disallowed with no rule', () => {
    // robots.txt could not be read at all (ADR-0035). Nothing was evaluated,
    // so no budget was exhausted.
    const decision = decideEnqueue(
      input({ candidate: candidate('https://example.test/x'), siteDisallowed: true }),
    );

    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.skipReason).toBe('robots_disallowed');
      expect(decision.rule).toBeNull();
    }
  });
});

describe('⚠️ every reason decide.ts emits is one the database can store', () => {
  it('SKIP_REASONS covers the whole set', () => {
    // A reason the enum cannot hold is a row the insert refuses, at crawl time,
    // on a path nothing in the unit suite would reach.
    const emitted = new Set<string>();
    const cases: readonly (readonly [string, Partial<DecideInput>])[] = [
      ['mailto:x@y.test', {}],
      [`https://example.test/${'a'.repeat(MAX_URL_LENGTH)}`, {}],
      ['https://other.test/x', {}],
      ['https://sub.example.test/x', {}],
      ['https://example.test/deep', { budget: { pageLimit: 500, maxDepth: 0, maxRows: 5000 } }],
      ['https://example.test/x', { siteDisallowed: true }],
      ['https://example.test/admin', { robots: parseRobotsTxt('User-agent: *\nDisallow: /admin') }],
      [
        `https://example.test/${'a'.repeat(MAX_URL_LENGTH - 21)}`,
        { robots: parseRobotsTxt(`User-agent: *\nDisallow: /*${'a'.repeat(1023)}b\n`) },
      ],
      [
        'https://example.test/x',
        {
          counts: { rows: 0, fetchable: 500 },
          budget: { pageLimit: 500, maxDepth: 10, maxRows: 5000 },
        },
      ],
    ];

    for (const [url, overrides] of cases) {
      const decision = decideEnqueue(input({ candidate: candidate(url), ...overrides }));
      if (!decision.accept) emitted.add(decision.skipReason);
    }

    expect(emitted.size).toBeGreaterThanOrEqual(8);
    for (const reason of emitted) {
      expect(SKIP_REASONS, `${reason} is not in the database enum`).toContain(reason);
    }
    // And both new ones actually fired, so this is not vacuous.
    expect(emitted).toContain('url_too_long');
    expect(emitted).toContain('budget_exhausted');
  });

  it('every SKIP_REASON has an operator-facing label', () => {
    for (const reason of SKIP_REASONS) {
      expect(SKIP_REASON_LABELS[reason], reason).toBeTruthy();
    }
  });
});
