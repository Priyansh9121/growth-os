/**
 * Walking a sitemap tree.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Follow a `sitemapindex` to its children, collect every page listed anywhere in
 * the tree, and stop — bounded, and honest about which bound stopped it.
 *
 * ⚠️ IT ADMITS NOTHING. This produces `Candidate`s; the frontier decides. A URL
 * here has passed no scope check, no robots check and no budget — it is a fact
 * about what a site listed, and turning that into work is `decideEnqueue`'s job
 * (§5, facts vs findings). `enqueueFromSitemap` is the caller that joins them,
 * and it adds no checks of its own.
 *
 * ⚠️ WHY THE RECURSION IS SEPARATE FROM THE DATABASE.
 * `decide.ts` makes the argument already: composition is where the interesting
 * bugs are, and a pure function can be tested exhaustively in microseconds while
 * the same logic inside a transaction can only be tested against the cases
 * somebody seeded. Cycles and depth bounds are exactly that kind of logic, so
 * they live here with only the network injected.
 *
 * @see docs/decisions/ADR-0052-sitemap-walk-bounds.md
 */

import type { SafeFetchDependencies } from '@growth-os/net';
import { fetchSitemap, type SitemapFetchOutcome } from './fetch';
import type { SitemapLimits } from './parse';
import type { Candidate } from '../frontier/decide';

export interface SitemapWalkLimits {
  /**
   * How deep `sitemapindex` nesting may go. The start document is depth 0.
   *
   * Three. sitemaps.org describes one level of index and Google documents
   * support for one; three leaves room for a generator that nests further
   * without following an index chain a site could extend indefinitely.
   */
  readonly maxIndexDepth: number;
  /**
   * Total documents fetched across the WHOLE tree, not per level.
   *
   * ⚠️ Per-level would not bound anything: an index of 50 indexes of 50 indexes
   * is 2,500 fetches with no level exceeding 50.
   */
  readonly maxSitemaps: number;
  /** Passed through to the parser. */
  readonly sitemap?: SitemapLimits;
}

export const DEFAULT_WALK_LIMITS: SitemapWalkLimits = {
  maxIndexDepth: 3,
  maxSitemaps: 50,
};

/** Which bound stopped the walk. A fact; absent when nothing stopped it. */
export type WalkStop = 'index_depth' | 'sitemap_limit';

/** One document the walk fetched, and how that went. */
export interface SitemapVisit {
  readonly url: string;
  readonly outcome: SitemapFetchOutcome;
  readonly depth: number;
}

export interface SitemapWalk {
  /** Every page listed anywhere in the tree, in document order. */
  readonly candidates: readonly Candidate[];
  readonly visited: readonly SitemapVisit[];
  /** Empty when the tree was walked completely. */
  readonly stopped: readonly WalkStop[];
  readonly deepestIndexDepth: number;
}

/**
 * Walk a sitemap tree from a starting document.
 *
 * ⚠️ THREE BOUNDS, AND EACH STOPS A DIFFERENT SHAPE OF ABUSE.
 *
 *  - **The seen set** stops cycles. A → B → A terminates by fetching each
 *    document once, without any counter having to fire. That matters: a cycle
 *    caught by a count bound would still have cost the whole budget.
 *  - **`maxIndexDepth`** stops an index chain a site can extend indefinitely.
 *  - **`maxSitemaps`** stops a wide tree, counted across every level.
 *
 * Breadth-first, so the total bound truncates the deepest, least likely levels
 * rather than abandoning a whole branch that happened to be visited first.
 */
export async function walkSitemaps(
  network: SafeFetchDependencies,
  startUrl: string,
  limits: SitemapWalkLimits = DEFAULT_WALK_LIMITS,
): Promise<SitemapWalk> {
  const candidates: Candidate[] = [];
  const visited: SitemapVisit[] = [];
  const stopped = new Set<WalkStop>();

  // ⚠️ Keyed on the URL as the parser normalised it, so two spellings of one
  // sitemap are one node. `parseSitemap` already ran every `<loc>` through
  // `normaliseUrl`; nothing is normalised a second time here (§5).
  const seen = new Set<string>([startUrl]);
  let queue: readonly { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
  let deepestIndexDepth = 0;

  while (queue.length > 0) {
    const next: { url: string; depth: number }[] = [];

    for (const node of queue) {
      if (visited.length >= limits.maxSitemaps) {
        stopped.add('sitemap_limit');
        return { candidates, visited, stopped: [...stopped], deepestIndexDepth };
      }

      const state = await fetchSitemap(
        network,
        node.url,
        limits.sitemap ? { limits: limits.sitemap } : {},
      );
      visited.push({ url: node.url, outcome: state.outcome, depth: node.depth });

      const document = state.document;
      if (document === null) continue;

      if (document.kind === 'urlset') {
        for (const entry of document.entries) {
          // ⚠️ DEPTH 0, AND SOURCE 'sitemap'. `DiscoverySource` already carried
          // `'sitemap'` before this module existed — nothing was invented for
          // it. Depth 0 because a listed page was not reached by traversing
          // links: the site asserted it directly, so there is no click distance
          // to report and inventing one would make `maxDepth` refuse pages for
          // a traversal that never happened.
          candidates.push({ url: entry.url, depth: 0, source: 'sitemap' });
        }
        continue;
      }

      // ⚠️ NARROWED EXPLICITLY, NOT BY ELIMINATION. `fetchSitemap` never returns
      // an `unknown` document — it reports `not_a_sitemap` and a null document —
      // but the TYPE still admits one, and relying on "it cannot happen" is how
      // a later change to that contract becomes a silent branch here.
      if (document.kind !== 'sitemapindex') continue;

      // Its children are one level deeper.
      const childDepth = node.depth + 1;
      if (childDepth > limits.maxIndexDepth) {
        stopped.add('index_depth');
        continue;
      }

      for (const child of document.sitemaps) {
        if (seen.has(child.url)) continue;
        seen.add(child.url);
        next.push({ url: child.url, depth: childDepth });
        if (childDepth > deepestIndexDepth) deepestIndexDepth = childDepth;
      }
    }

    queue = next;
  }

  return { candidates, visited, stopped: [...stopped], deepestIndexDepth };
}
