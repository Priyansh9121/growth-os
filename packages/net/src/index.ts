/**
 * @growth-os/net — the one outbound HTTP client.
 *
 * ⚠️ EVERY REQUEST GROWTH OS MAKES TO AN ADDRESS A CUSTOMER SUPPLIED GOES
 * THROUGH `safeFetch`. Site verification, robots.txt, sitemaps, page crawling —
 * and every outbound integration a later stage adds.
 *
 * BOUNDARY: this package depends on NOTHING inside Growth OS. Not contracts,
 * not database, not crm. It is deliberately reviewable on its own, and the
 * boundary probes assert that no other package opens a socket: `node:http`,
 * `node:https`, `node:net` and `node:dns` are importable HERE and nowhere else
 * in the repository.
 *
 * WHY THAT RULE IS THE ARCHITECTURE
 * "Remember to use the safe fetcher" is a convention, and conventions are what
 * a deadline erodes. A package boundary with a lint probe behind it is a build
 * failure, which is the only kind of reminder that survives.
 *
 * @see docs/security/crawler-ssrf-threat-model.md
 * @see docs/decisions/ADR-0032-crawler-network-security.md
 */
export * from './address/ranges';
export * from './address/classify';
export * from './url/policy';
export * from './http/resolve';
export * from './http/transport';
export * from './http/fetch';
