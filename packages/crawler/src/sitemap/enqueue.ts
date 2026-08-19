/**
 * The join between a sitemap walk and the frontier.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One entry point: given a starting sitemap URL, walk the tree and offer
 * everything it listed to the frontier. That is the whole file, and its size is
 * the point.
 *
 * ⚠️ IT ADDS NO CHECKS OF ITS OWN, AND THAT IS THE INVARIANT (§5).
 *
 * A sitemap-discovered URL is admitted by `enqueueDiscovered` — the same
 * function, the same `decideEnqueue`, the same scope check, the same robots
 * consultation, the same budget and the same row ceiling as a URL found in an
 * anchor tag. There is no sitemap-specific admission rule anywhere, because a
 * second admission path is how the two drift and one of them ends up more
 * permissive.
 *
 * `DiscoverySource` already carried `'sitemap'` before this module existed, so
 * the frontier could already distinguish these rows. Nothing was invented for
 * it — verified in `decide.ts` before this was written.
 *
 * ⚠️ IT IS SEPARATE FROM `walk.ts` ON PURPOSE. The walk takes only a network,
 * so its bounds — cycles, depth, the total — are unit-testable in microseconds.
 * This takes a transaction. Keeping them in one file would drag the recursion
 * logic into a suite that can only test what somebody seeded a database for,
 * which is the argument `decide.ts` already makes for itself.
 *
 * @see docs/decisions/ADR-0052-sitemap-walk-bounds.md
 */

import type { TenantTransaction } from '@growth-os/database';
import type { SafeFetchDependencies } from '@growth-os/net';
import {
  enqueueDiscovered,
  type EnqueueEnvironment,
  type EnqueueSummary,
} from '../frontier/frontier';
import { walkSitemaps, type SitemapWalk, type SitemapWalkLimits } from './walk';

export interface SitemapEnqueueResult {
  /** What the walk found, and which bound stopped it. Facts about the tree. */
  readonly walk: SitemapWalk;
  /**
   * What the frontier did with it.
   *
   * ⚠️ COUNTS HERE, PER-URL REASONS IN THE ROWS. `enqueueDiscovered` writes a
   * `skip_reason` on every refused URL, so "why was this one not crawled" is
   * answerable per URL from the frontier itself. Duplicating those reasons into
   * a return value would be a second copy of a fact the database already holds.
   */
  readonly summary: EnqueueSummary;
}

/**
 * Walk a sitemap tree and offer everything it lists to the frontier.
 *
 * ⚠️ `discoveredFrom` IS LEFT NULL, AND THE REASON IS A CORRECTION.
 *
 * The parameter is typed `string | null`, which reads like a URL — and the
 * first version of this passed the starting sitemap URL. It is a **`uuid`
 * self-reference to another `crawl_frontier` row** (`crawl.ts:277`), so the
 * insert was rejected by the database. Read the schema, not the signature: a
 * `string` parameter is a UUID as readily as a URL.
 *
 * Null is then the honest value rather than a workaround. A sitemap document is
 * not a frontier row — sitemaps are fetched, never queued as pages — so there
 * is no row for a sitemap-discovered URL to point at. `discovery_source =
 * 'sitemap'` is what records how it was found.
 *
 * ⚠️ The cost, stated: for a `sitemapindex` tree the frontier records THAT a
 * URL came from a sitemap, not WHICH sitemap listed it. Recording that would
 * need a column the schema does not have, and adding one is a migration outside
 * this brief.
 */
export async function enqueueFromSitemap(
  tx: TenantTransaction,
  workspaceId: string,
  crawlId: string,
  environment: EnqueueEnvironment,
  network: SafeFetchDependencies,
  startUrl: string,
  limits?: SitemapWalkLimits,
): Promise<SitemapEnqueueResult> {
  const walk = await walkSitemaps(network, startUrl, limits);

  const summary = await enqueueDiscovered(tx, workspaceId, crawlId, environment, walk.candidates);

  return { walk, summary };
}
