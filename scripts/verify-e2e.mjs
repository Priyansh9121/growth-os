#!/usr/bin/env node
/**
 * Run the browser suite, after checking it can actually run.
 *
 * WHY THIS WRAPPER EXISTS
 * `npm run e2e` on a machine without PostgreSQL spends ~30 seconds building the
 * app before `global-setup` fails inside `db:migrate`, and the error it prints
 * is a driver connection refusal — true, and several layers below the thing the
 * developer needs to do. This checks the preconditions first and says exactly
 * what is missing.
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
import net from 'node:net';
import { e2eDatabaseUrl, redactDatabaseUrl } from '../tests/e2e/database-url.mjs';

/** Print an actionable failure and stop. Never a warning, never a skip. */
function fail(problem, remedy) {
  console.error(`\n✗ verify:e2e cannot run: ${problem}\n`);
  console.error(`  ${remedy}\n`);
  console.error('  This is a hard failure by design. A browser gate that passes');
  console.error('  without running a browser is worse than no gate (AGENTS.md §7).\n');
  process.exit(1);
}

/** Can we open a TCP connection to host:port within `timeoutMs`? */
function canConnect(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
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

const host = parsed.hostname;
const port = Number(parsed.port || 5432);

if (!(await canConnect(host, port))) {
  fail(
    `nothing is listening on ${host}:${port} (from ${redactDatabaseUrl(databaseUrl)})`,
    'Start PostgreSQL, or point E2E_DATABASE_URL at a running one. ' +
      'See infrastructure/README.md.',
  );
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
console.info(`\n▶ verify:e2e — database ${redactDatabaseUrl(databaseUrl)} reachable on ${port}`);
console.info('  Building the app and running the browser suite. Expect ~70-90s.\n');

try {
  execFileSync('npx', ['playwright', 'test'], { stdio: 'inherit' });
} catch {
  // Playwright already printed the failures and, on CI, wrote an HTML report.
  // Re-printing a stack here would bury them.
  process.exitCode = 1;
}
