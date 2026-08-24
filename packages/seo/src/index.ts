/**
 * @growth-os/seo — the audit layer.
 *
 * BOUNDARY: this package may depend on @growth-os/contracts and
 * @growth-os/database, and nothing else internal.
 *
 * ⚠️ IT DEPENDS ON THE CRAWLER'S TABLES, NOT ON THE CRAWLER. There is no
 * `@growth-os/crawler` dependency and there must not be one: an audit reads
 * facts that are already recorded, and a rule that could call the crawler could
 * decide to go and fetch something first. That the audit layer cannot open a
 * socket is then a fact `verify:boundaries` proves, not a comment.
 *
 * @see docs/decisions/ADR-0071-the-audit-layer-is-its-own-package.md
 */

export {
  findOrphanPages,
  orphanFindings,
  recordOrphanPages,
  RETRIEVED_OUTCOMES,
  type OrphanAudit,
  type OrphanAuditResult,
  type OrphanPage,
} from './rules/orphan-pages';
