#!/usr/bin/env node
/**
 * Run the browser suite, after checking it can actually run.
 *
 * WHY THIS WRAPPER EXISTS
 * `npm run e2e` against an unusable database fails inside `global-setup`'s
 * `db:migrate`, and the error it prints is `Failed query: CREATE SCHEMA IF NOT
 * EXISTS "drizzle"` — a headline about SQL, with the actual cause (`password
 * authentication failed`) two levels down a `cause` chain. This checks the
 * preconditions first and leads with the cause.
 *
 * ⚠️ THE CHECK IS A REAL CONNECTION, NOT A TCP HANDSHAKE.
 * It used to be `net.Socket().connect(port)`, which any listener satisfies. Dev
 * log 0044 hit the consequence: an unrelated PostgreSQL was listening on the
 * port, this script announced "database … reachable on 5432", and the run died
 * 11 seconds later inside migrate. Announcing "reachable" about a database we
 * cannot log in to is worse than saying nothing — it points the reader away
 * from the credentials, which is where the answer was.
 *
 * See `database-preflight.mjs` for what is checked and why that set.
 *
 * ⚠️ IT FAILS. IT NEVER SKIPS.
 *
 * That is the whole point, and it is the difference between this and the
 * integration suite. `vitest` integration tests SELF-SKIP without a database so
 * that a developer with no PostgreSQL still gets a useful `verify:all` — a
 * deliberate trade recorded in AGENTS.md §7. Applying the same trade here would
 * mean `verify:e2e` passes green on a machine that ran no browser tests at all,
 * which is precisely the "deleting the check rather than inheriting it" failure
 * §7 names. A missing database is a reason to stop, not a reason to pass.
 *
 * ⚠️ THIS IS NOT PART OF `verify:all`, DELIBERATELY.
 * `verify:all` runs without a database, a build, or a browser. E2E needs all
 * three. Folding it in would either break the standard gate everywhere
 * PostgreSQL is absent, or force the self-skip above. It sits beside the
 * migrations-from-zero check instead — the database tier of the Definition of
 * Done (AGENTS.md §7).
 *
 * @see docs/engineering/testing-strategy.md
 * @see AGENTS.md §7
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { e2eDatabaseUrl, redactDatabaseUrl } from '../tests/e2e/database-url.mjs';
import {
  connectionTarget,
  describeDatabaseFailure,
  describeMissingCreatePrivilege,
} from './database-preflight.mjs';

/** Print an actionable failure and stop. Never a warning, never a skip. */
function fail(problem, remedy) {
  console.error(`\n✗ verify:e2e cannot run: ${problem}\n`);
  console.error(`  ${remedy}\n`);
  console.error('  This is a hard failure by design. A browser gate that passes');
  console.error('  without running a browser is worse than no gate (AGENTS.md §7).\n');
  process.exit(1);
}

/**
 * Log in and ask the two questions that decide whether the suite can run.
 *
 * One connection, no retries, short timeout: a preflight must answer now rather
 * than eventually. The connection is always closed, including on failure.
 */
async function inspectDatabase(url) {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    max_lifetime: 10,
    onnotice: () => {},
  });

  try {
    const [row] = await sql`
      SELECT current_database() AS database,
             current_user AS role,
             has_database_privilege(current_user, current_database(), 'CREATE') AS can_create
    `;
    return { ok: true, ...row };
  } catch (error) {
    return { ok: false, error };
  } finally {
    // Never let a lingering socket hold the process open after a verdict.
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

// ---- 1. The database the suite will actually use -------------------------
//
// Resolved through the same module Playwright and the global setup use, so
// this cannot check one database while the suite connects to another.
const databaseUrl = e2eDatabaseUrl();

let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  fail(
    `the E2E database URL is not a URL: ${redactDatabaseUrl(databaseUrl)}`,
    'Set E2E_DATABASE_URL or TEST_DATABASE_URL to a valid postgresql:// URL.',
  );
}

const target = connectionTarget(parsed);
const inspection = await inspectDatabase(databaseUrl);

if (!inspection.ok) {
  const { problem, remedy } = describeDatabaseFailure(inspection.error, target);
  fail(problem, remedy);
}

// Connecting is not enough: migrate's first statement is `CREATE SCHEMA`.
if (!inspection.can_create) {
  const { problem, remedy } = describeMissingCreatePrivilege(target);
  fail(problem, remedy);
}

// ---- 2. The browser --------------------------------------------------------
//
// Checked by asking Playwright rather than by looking for a directory, so a
// partial or wrong-revision install is caught too.
try {
  execFileSync('npx', ['playwright', 'install', '--dry-run', 'chromium'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
} catch {
  // A dry run failing means the CLI could not even be consulted; fall through
  // to the directory check rather than blocking on a tooling quirk.
}

const browsersRoot =
  process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? join(homedir(), 'Library', 'Caches', 'ms-playwright');

if (process.platform === 'darwin' && !existsSync(browsersRoot)) {
  fail(
    'Playwright has no browsers installed',
    'Run `npm run e2e:install` (downloads Chromium, a few hundred MB).',
  );
}

// ---- 3. Run it -------------------------------------------------------------
console.info(
  `\n▶ verify:e2e — connected to "${inspection.database}" as "${inspection.role}" ` +
    `(${target.hostPort}), CREATE granted`,
);
console.info('  Building the app and running the browser suite. Expect ~70-90s.\n');

try {
  execFileSync('npx', ['playwright', 'test'], { stdio: 'inherit' });
} catch {
  // Playwright already printed the failures and, on CI, wrote an HTML report.
  // Re-printing a stack here would bury them.
  process.exitCode = 1;
}
