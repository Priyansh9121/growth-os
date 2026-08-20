/**
 * Where the browser suite's database lives — resolved in exactly one place.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Three things need this answer and must never disagree about it: the
 * Playwright config (which passes it to the server under test), the global
 * setup (which migrates and seeds it), and the `verify:e2e` preflight (which
 * checks it is reachable before spending 70 seconds finding out).
 *
 * ⚠️ IT IS `.mjs` SO ALL THREE CAN IMPORT IT. Two of them are TypeScript
 * compiled by Playwright's own bundler; the third is a plain Node script run by
 * npm. A `.mjs` module is the one shape every one of them loads without a build
 * step.
 *
 * ⚠️ WHY IT IS SHARED AT ALL. The literal below was duplicated in the config and
 * the global setup. Adding a third copy for the preflight would have made a
 * preflight that can pass while the suite connects somewhere else — a check
 * that lies, which is worse than no check. Same reasoning as AGENTS.md §7: a
 * parallel copy drifts, and the copy is always the one that is wrong.
 *
 * @see docs/engineering/testing-strategy.md
 */

/**
 * The E2E database URL.
 *
 * Separate from the development database so a run cannot destroy work in
 * progress — `global-setup` seeds destructively.
 *
 * `E2E_DATABASE_URL` wins so a machine can point the browser suite somewhere
 * other than its integration database; `TEST_DATABASE_URL` is the ordinary
 * local case; the literal is the documented default from
 * `infrastructure/docker-compose.yml`.
 */
export function e2eDatabaseUrl() {
  return (
    process.env['E2E_DATABASE_URL'] ??
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://growth_os:growth_os@127.0.0.1:5432/growth_os_test'
  );
}

/** The same URL with its password masked, for logs. */
export function redactDatabaseUrl(url) {
  return url.replace(/:[^:@/]*@/, ':***@');
}
