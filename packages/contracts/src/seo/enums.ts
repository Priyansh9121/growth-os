/**
 * The audit layer's vocabulary — what a finding can be about.
 *
 * ⚠️ A RULE NAME, NOT A SEVERITY AND NOT A SENTENCE.
 * `orphan_page` says which measurement was taken. It does not say the page is
 * broken, how bad it is, or what to do about it. Severity and effort are Stage
 * 5's later deliverables and a ranking is a product decision; a rule identifier
 * is a fact about which question was asked (AGENTS.md §5).
 *
 * ⚠️ NO HUMAN-READABLE LABEL MAP HERE, unlike `CRAWL_FAILURE_LABELS`.
 * A failure category has one true rendering — it describes what happened to a
 * fetch. A finding's rendering is copy: "orphan page", "no internal links",
 * "unreachable from your navigation" are the same fact addressed to three
 * different readers, and choosing between them is a UI concern. Putting one of
 * them here would make the copy decision in the layer that must not make it.
 *
 * @see docs/decisions/ADR-0070-findings-belong-to-a-crawl.md
 */

/**
 * Every rule the audit layer can run. ONE, deliberately.
 *
 * ⚠️ THE LIST IS SHORT BECAUSE THE IMPLEMENTATION IS. A member here with no
 * rule behind it is a promise the database records and nothing keeps — and the
 * enum is what the `seo_findings.rule` column accepts, so an aspirational
 * member is a value that can be written and never explained.
 */
export const SEO_FINDING_RULES = ['orphan_page'] as const;
export type SeoFindingRule = (typeof SEO_FINDING_RULES)[number];
