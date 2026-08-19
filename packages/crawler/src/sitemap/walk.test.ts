/**
 * Walking a sitemap tree — the recursion, and the bounds that stop it.
 *
 * ⚠️ EVERY TERMINATION TEST ASSERTS WHICH BOUND FIRED AND WHAT IT REACHED.
 *
 * "It finished" is the weak property: a cycle that terminates because the
 * fixture happened to run out of routes proves nothing about the code. Each
 * case below asserts the specific bound in `stopped` and the specific count or
 * depth reached, so a regression that removed a bound would fail rather than
 * pass slowly.
 *
 * @see docs/decisions/ADR-0052-sitemap-walk-bounds.md
 */

import { describe, expect, it } from 'vitest';
import { type SafeFetchDependencies } from '@growth-os/net';
import { FixtureResolver, FixtureTransport } from '@growth-os/net/testing';
import { DEFAULT_WALK_LIMITS, walkSitemaps } from './walk';

const PUBLIC_IP = '93.184.216.34';
const ORIGIN = 'https://example.test';

const urlset = (...paths: string[]): string =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`)
    .join('')}</urlset>`;

const index = (...urls: string[]): string =>
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<sitemap><loc>${u}</loc></sitemap>`)
    .join('')}</sitemapindex>`;

/** A network serving one XML document per URL. */
function network(documents: Record<string, string>): SafeFetchDependencies {
  const routes: Record<string, { status: number; headers: Record<string, string>; body: string }> =
    {};
  for (const [url, body] of Object.entries(documents)) {
    routes[url] = { status: 200, headers: { 'content-type': 'application/xml' }, body };
  }
  return {
    resolver: new FixtureResolver({ 'example.test': [PUBLIC_IP] }),
    transport: new FixtureTransport(routes),
  };
}

describe('walkSitemaps — the ordinary shapes', () => {
  it('reads a plain urlset and produces one candidate per page', async () => {
    const walk = await walkSitemaps(
      network({ [`${ORIGIN}/sitemap.xml`]: urlset('/', '/contact') }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk.candidates.map((c) => c.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/contact`]);
    expect(walk.stopped).toEqual([]);
  });

  it('⚠️ marks every candidate as sitemap-discovered, at depth 0', async () => {
    // `source: 'sitemap'` already exists in `DiscoverySource` — nothing new was
    // invented for this. Depth 0 because a sitemap-listed page was not reached
    // by traversing links: the site asserted it directly, so there is no click
    // distance to report and none should be fabricated.
    const walk = await walkSitemaps(
      network({ [`${ORIGIN}/sitemap.xml`]: urlset('/a') }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk.candidates[0]).toEqual({ url: `${ORIGIN}/a`, depth: 0, source: 'sitemap' });
  });

  it('follows a sitemapindex to its children and collects from all of them', async () => {
    const walk = await walkSitemaps(
      network({
        [`${ORIGIN}/sitemap.xml`]: index(`${ORIGIN}/s1.xml`, `${ORIGIN}/s2.xml`),
        [`${ORIGIN}/s1.xml`]: urlset('/a', '/b'),
        [`${ORIGIN}/s2.xml`]: urlset('/c'),
      }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk.candidates.map((c) => c.url)).toEqual([
      `${ORIGIN}/a`,
      `${ORIGIN}/b`,
      `${ORIGIN}/c`,
    ]);
    expect(walk.visited).toHaveLength(3);
    expect(walk.stopped).toEqual([]);
  });

  it('records every document it fetched and how that went — facts, not a verdict', async () => {
    const walk = await walkSitemaps(
      network({
        [`${ORIGIN}/sitemap.xml`]: index(`${ORIGIN}/s1.xml`, `${ORIGIN}/missing.xml`),
        [`${ORIGIN}/s1.xml`]: urlset('/a'),
      }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk.visited).toEqual([
      { url: `${ORIGIN}/sitemap.xml`, outcome: 'fetched', depth: 0 },
      { url: `${ORIGIN}/s1.xml`, outcome: 'fetched', depth: 1 },
      { url: `${ORIGIN}/missing.xml`, outcome: 'absent', depth: 1 },
    ]);
  });

  it('a child that cannot be read costs that child and nothing else', async () => {
    const walk = await walkSitemaps(
      network({
        [`${ORIGIN}/sitemap.xml`]: index(`${ORIGIN}/gone.xml`, `${ORIGIN}/s2.xml`),
        [`${ORIGIN}/s2.xml`]: urlset('/c'),
      }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk.candidates.map((c) => c.url)).toEqual([`${ORIGIN}/c`]);
  });
});

describe('⚠️ walkSitemaps — termination, proven by which bound fired', () => {
  it('⚠️ a CYCLE terminates because each sitemap is fetched at most once', async () => {
    // A's index lists B; B's index lists A. Without the seen-set this recurses
    // until a depth or count bound fires — so the assertion is not merely that
    // it finished, but that it finished having fetched EXACTLY the two distinct
    // documents, with no bound needing to fire at all.
    const walk = await walkSitemaps(
      network({
        [`${ORIGIN}/a.xml`]: index(`${ORIGIN}/b.xml`),
        [`${ORIGIN}/b.xml`]: index(`${ORIGIN}/a.xml`),
      }),
      `${ORIGIN}/a.xml`,
    );

    expect(walk.visited.map((v) => v.url)).toEqual([`${ORIGIN}/a.xml`, `${ORIGIN}/b.xml`]);
    expect(walk.visited).toHaveLength(2);
    expect(walk.stopped).toEqual([]);
  });

  it('⚠️ a self-referencing sitemap is fetched once', async () => {
    const walk = await walkSitemaps(
      network({ [`${ORIGIN}/a.xml`]: index(`${ORIGIN}/a.xml`) }),
      `${ORIGIN}/a.xml`,
    );

    expect(walk.visited).toHaveLength(1);
  });

  it('⚠️ a chain deeper than maxIndexDepth stops AT the bound, and says so', async () => {
    // index -> index -> index -> index -> index -> urlset. With maxIndexDepth 3
    // the walk must never reach the urlset, and must report the depth bound as
    // the reason rather than silently returning fewer pages.
    const documents: Record<string, string> = {};
    for (let level = 0; level < 6; level++) {
      documents[`${ORIGIN}/i${level}.xml`] = index(`${ORIGIN}/i${level + 1}.xml`);
    }
    documents[`${ORIGIN}/i6.xml`] = urlset('/deep');

    const walk = await walkSitemaps(network(documents), `${ORIGIN}/i0.xml`);

    expect(walk.stopped).toContain('index_depth');
    expect(walk.deepestIndexDepth).toBe(DEFAULT_WALK_LIMITS.maxIndexDepth);
    // The urlset past the bound is never reached, so its page is never found.
    expect(walk.candidates).toHaveLength(0);
    expect(walk.visited).toHaveLength(DEFAULT_WALK_LIMITS.maxIndexDepth + 1);
  });

  it('⚠️ a tree wider than maxSitemaps stops AT the bound, and says so', async () => {
    // One index listing twice the permitted number of children. The bound is on
    // the TOTAL fetched across the whole tree, not per level.
    const children = Array.from(
      { length: DEFAULT_WALK_LIMITS.maxSitemaps * 2 },
      (_, i) => `${ORIGIN}/s${i}.xml`,
    );
    const documents: Record<string, string> = { [`${ORIGIN}/sitemap.xml`]: index(...children) };
    for (const [i, child] of children.entries()) documents[child] = urlset(`/p${i}`);

    const walk = await walkSitemaps(network(documents), `${ORIGIN}/sitemap.xml`);

    expect(walk.stopped).toContain('sitemap_limit');
    expect(walk.visited).toHaveLength(DEFAULT_WALK_LIMITS.maxSitemaps);
  });

  it('⚠️ the total bound counts across levels, not within one', async () => {
    // A tree that is narrow at every level but long overall: no single index
    // exceeds the width, and the whole tree still must not exceed the total.
    const documents: Record<string, string> = {};
    documents[`${ORIGIN}/root.xml`] = index(
      ...Array.from({ length: 4 }, (_, i) => `${ORIGIN}/mid${i}.xml`),
    );
    for (let i = 0; i < 4; i++) {
      documents[`${ORIGIN}/mid${i}.xml`] = index(
        ...Array.from({ length: 4 }, (_, j) => `${ORIGIN}/leaf${i}-${j}.xml`),
      );
      for (let j = 0; j < 4; j++) documents[`${ORIGIN}/leaf${i}-${j}.xml`] = urlset(`/p${i}${j}`);
    }

    const walk = await walkSitemaps(network(documents), `${ORIGIN}/root.xml`, {
      ...DEFAULT_WALK_LIMITS,
      maxSitemaps: 7,
    });

    expect(walk.stopped).toContain('sitemap_limit');
    expect(walk.visited).toHaveLength(7);
  });

  it('the bounds are configurable, and a smaller one fires sooner', async () => {
    const documents: Record<string, string> = {
      [`${ORIGIN}/i0.xml`]: index(`${ORIGIN}/i1.xml`),
      [`${ORIGIN}/i1.xml`]: index(`${ORIGIN}/i2.xml`),
      [`${ORIGIN}/i2.xml`]: urlset('/a'),
    };

    const shallow = await walkSitemaps(network(documents), `${ORIGIN}/i0.xml`, {
      ...DEFAULT_WALK_LIMITS,
      maxIndexDepth: 1,
    });

    expect(shallow.stopped).toContain('index_depth');
    expect(shallow.deepestIndexDepth).toBe(1);
    expect(shallow.candidates).toHaveLength(0);
  });
});

describe('walkSitemaps — what it does not do', () => {
  it('⚠️ does not admit anything itself — it produces candidates only', async () => {
    // Admission is the frontier's, and routing through it is the caller's job.
    // A URL here has passed no scope check, no robots check and no budget: it
    // is a fact about what the site listed, nothing more (§5).
    const walk = await walkSitemaps(
      network({ [`${ORIGIN}/sitemap.xml`]: urlset('/a') }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk).not.toHaveProperty('queued');
    expect(walk).not.toHaveProperty('admitted');
    expect(walk.candidates[0]?.source).toBe('sitemap');
  });

  it('does not rank or reorder what it found', async () => {
    // Document order, preserved. `priority` and `lastmod` are the site's claims
    // and this layer still declines to interpret them.
    const walk = await walkSitemaps(
      network({ [`${ORIGIN}/sitemap.xml`]: urlset('/z', '/a', '/m') }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk.candidates.map((c) => c.url)).toEqual([
      `${ORIGIN}/z`,
      `${ORIGIN}/a`,
      `${ORIGIN}/m`,
    ]);
  });

  it('a start URL that is not a sitemap yields nothing and says what happened', async () => {
    const walk = await walkSitemaps(
      network({ [`${ORIGIN}/sitemap.xml`]: '<html><body>404</body></html>' }),
      `${ORIGIN}/sitemap.xml`,
    );

    expect(walk.candidates).toHaveLength(0);
    expect(walk.visited[0]?.outcome).toBe('not_a_sitemap');
  });
});
