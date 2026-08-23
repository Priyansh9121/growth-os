/**
 * Writing the link graph, and turning it into frontier candidates.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * `extractLinks` produces facts about one document. This puts them in
 * `crawl_links` and says which of them are worth offering to the frontier. It
 * adds no rule about whether a URL may be crawled — that is `decideEnqueue`'s,
 * and it stays there.
 *
 * ⚠️ FACTS, NOT FINDINGS (AGENTS.md §5). Every link the document stated is
 * recorded, including the ones that will never be fetched: external targets,
 * `nofollow`, subdomains. "This page has too few internal links" is Stage 5's
 * sentence to write, and it can only write it if the rows are all here.
 *
 * ⚠️ WHY THIS IS NOT IN `frontier.ts`. The frontier is what will be fetched.
 * The link graph is what a document said. They share a transaction, not a
 * responsibility — and `crawl_links` outlives every question the frontier
 * answers.
 *
 * @see docs/decisions/ADR-0067-the-observation-id-is-the-retry-signal.md
 * @see docs/decisions/ADR-0069-discovered-links-become-frontier-candidates.md
 */

import { schemaTables, type TenantTransaction } from '@growth-os/database';
import type { Candidate } from '../frontier/decide';
import type { ExtractedLink } from './extract';

const { crawlLinks } = schemaTables;

/**
 * Rows per INSERT statement.
 *
 * ⚠️ NOT A PERFORMANCE TUNING. PostgreSQL accepts at most 65535 bound
 * parameters in one statement, and each row here binds 7. At
 * `MAX_LINKS_PER_PAGE` (5,000) a single statement would bind 35,000 — under the
 * ceiling today, and silently over it the moment either number moves. Chunking
 * makes that coupling not exist rather than documenting it.
 */
const INSERT_CHUNK = 500;

export interface RecordLinksInput {
  readonly crawlId: string;
  /**
   * `crawl_pages.id` — the OBSERVATION, not the durable `site_pages` identity.
   *
   * ⚠️ Only ever the non-null `crawlPageId` from `markFetched`. Passing an id
   * from a retry that wrote nothing would duplicate every link on the page,
   * because `crawl_links` has no unique index to refuse it (ADR-0067).
   */
  readonly sourcePageId: string;
  readonly links: readonly ExtractedLink[];
}

/**
 * Record what one page linked to. Returns the number of rows written.
 *
 * Takes the caller's transaction, so the links and the observation they hang
 * off commit together or not at all — which is what makes gating on
 * `crawlPageId` sound rather than merely convenient.
 */
export async function recordLinks(
  tx: TenantTransaction,
  workspaceId: string,
  input: RecordLinksInput,
): Promise<number> {
  if (input.links.length === 0) return 0;

  // ⚠️ NOT DEDUPLICATED. A page that links to /contact from its nav and again
  // from its footer stated two edges, and both are facts — they differ in
  // anchor text, and a link audit that collapses them cannot count either.
  // ADR-0067 records why this table has no unique key to collapse them with.
  const rows = input.links.map((link) => ({
    workspaceId,
    crawlId: input.crawlId,
    sourcePageId: input.sourcePageId,
    targetUrl: link.targetUrl,
    scope: link.scope,
    anchorText: link.anchorText,
    isNofollow: link.isNofollow,
  }));

  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    await tx.insert(crawlLinks).values(rows.slice(offset, offset + INSERT_CHUNK));
  }

  return rows.length;
}

/**
 * The links worth offering to the frontier, as candidates at the next depth.
 *
 * ⚠️ INTERNAL ONLY, AND THIS IS NOT A SECOND SCOPE RULE.
 * The verdict is `link.scope`, which `extractLinks` got from the one
 * `classifyScope` (AGENTS.md §5, URL identity is singular). Nothing is
 * re-decided here; out-of-scope links are simply not offered.
 *
 * `decideEnqueue` would refuse them anyway — but refusing costs a row, and the
 * row ceiling is finite. One page's outbound links would spend the budget the
 * crawl needs to record its own site, and the fact that we saw them is already
 * recorded, better, in `crawl_links`.
 *
 * ⚠️ `nofollow` IS RECORDED AND NOT FILTERED. It tells a search engine not to
 * pass weight; it does not tell a site's own auditor not to look. A customer's
 * `nofollow`-ed internal page is exactly the kind of page an audit exists to
 * find. Turning it into an admission rule would be a decision for
 * `decideEnqueue` and its ADR, not a filter smuggled in here.
 *
 * ⚠️ DEPTH IS THE CALLER'S. `decideEnqueue` uses `candidate.depth` verbatim,
 * so a link found on a page at depth N is offered at N + 1 — the link hop the
 * `crawl_frontier.depth` comment describes.
 */
export function linkCandidates(links: readonly ExtractedLink[], depth: number): Candidate[] {
  return links
    .filter((link) => link.scope === 'internal')
    .map((link) => ({ url: link.targetUrl, depth, source: 'link' as const }));
}
