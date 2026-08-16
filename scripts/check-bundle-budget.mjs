#!/usr/bin/env node
/**
 * Per-route bundle budget gate.
 *
 * WHY THIS EXISTS
 * Stage 1 measured bundle sizes by hand and found both main routes marginally
 * over budget. A number measured once is a number that drifts: without a gate,
 * the next dependency added is discovered at the next manual measurement,
 * which is to say never.
 *
 * HOW IT MEASURES
 * Starts the production server, fetches each route's HTML, and sums the gzipped
 * size of every `_next/static/chunks` script the document references. That is
 * the actual initial JavaScript a browser downloads — not an approximation
 * from the build manifest, which lists chunks a route *may* use rather than
 * the ones its document actually pulls.
 *
 * Requires an authenticated session for app routes, so it signs in with the
 * seeded account exactly as the E2E suite does.
 *
 *   node scripts/check-bundle-budget.mjs            # measure and enforce
 *   node scripts/check-bundle-budget.mjs --report   # measure only, never fail
 *
 * @see docs/design/performance-budget.md
 */

import { execFile, spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(repoRoot, 'apps/web');
const PORT = Number(process.env['BUNDLE_PORT'] ?? 3220);
const BASE = `http://127.0.0.1:${PORT}`;
const reportOnly = process.argv.includes('--report');

/**
 * Budgets in KB gzip.
 *
 * Stage 1 measured login at 252.5 KB and dashboard at 260.8 KB against a
 * 250 KB target. Those overages are REAL and are recorded in
 * performance-budget.md rather than being defined away — so the gate is set at
 * a ceiling that prevents further growth while the documented reduction work
 * is outstanding. Lowering these is the goal; raising one requires an entry in
 * the performance budget explaining why.
 */
const BUDGETS = [
  { route: '/login', budgetKb: 275, auth: false },
  { route: '/dashboard', budgetKb: 285, auth: true },
  { route: '/customers/contacts', budgetKb: 300, auth: true },
  { route: '/customers/pipeline', budgetKb: 300, auth: true },
  { route: '/customers/tasks', budgetKb: 300, auth: true },
  // Stage 2.5. Companies is a plain server-rendered table and should stay the
  // cheapest route in the product; if it ever approaches the others, something
  // has been made a client component that did not need to be.
  { route: '/customers/companies', budgetKb: 300, auth: true },
  // The import wizard is genuinely stateful across four steps, so it carries
  // real client code. Budgeted like the rest rather than exempted.
  { route: '/customers/import', budgetKb: 300, auth: true },
  { route: '/system/crm-fields', budgetKb: 300, auth: true },
  // Stage 3.
  { route: '/conversion/forms', budgetKb: 300, auth: true },
  /**
   * ⚠️ THE PUBLIC FORM, and the tightest budget in the product.
   *
   * It renders inside an iframe on a CUSTOMER'S WEBSITE, where our bytes
   * compete with their Lighthouse score and their conversion rate. It is
   * unauthenticated, so `auth: false` — it must render for a stranger.
   *
   * 200 KB is well below the app routes because it carries no shell, no
   * navigation and no session: if it ever approaches them, something from the
   * authenticated application has leaked into the public bundle.
   */
  { route: '/f/5eed0000000000000000000000000f01', budgetKb: 200, auth: false },
];

/** three.js must never appear in a route's INITIAL bundle. */
const THREE_MARKER = 'WebGLRenderer';

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd: repoRoot, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || stdout}`));
      else resolvePromise(stdout);
    });
  });
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/login`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become ready');
}

/** Sum the gzipped size of every chunk the document references. */
function measureHtml(html) {
  const chunks = [
    ...new Set([...html.matchAll(/\/_next\/(static\/chunks\/[^"']+?\.js)/g)].map((m) => m[1])),
  ];

  let totalGzip = 0;
  let containsThree = false;

  for (const chunk of chunks) {
    const path = resolve(webRoot, '.next', chunk);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    totalGzip += gzipSync(bytes, { level: 6 }).length;
    if (bytes.includes(THREE_MARKER)) containsThree = true;
  }

  return { chunkCount: chunks.length, totalGzip, containsThree };
}

async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    APP_URL: BASE,
    DATABASE_URL:
      process.env['BUNDLE_DATABASE_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgresql://growth_os:growth_os@127.0.0.1:5432/growth_os',
    SESSION_SECRET: 'bundle-measurement-secret-not-used-elsewhere',
  };

  console.log('Building…');
  await run('npm', ['run', 'build'], { env, maxBuffer: 32 * 1024 * 1024 });

  const server = spawn('npm', ['run', 'start'], { cwd: repoRoot, env, stdio: 'ignore' });

  let failures = 0;
  try {
    await waitForServer();

    // App routes need a session, so sign in as the seeded owner.
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: BASE },
      body: JSON.stringify({
        email: 'sam@abcplumbing.test',
        password: process.env['SEED_PASSWORD'] ?? 'DevOnly!Growth0S',
      }),
    });
    const cookie = login.headers.getSetCookie?.().join('; ') ?? '';

    console.log('\n  route                        gzip     budget   status');
    console.log('  ' + '-'.repeat(58));

    for (const target of BUDGETS) {
      const response = await fetch(`${BASE}${target.route}`, {
        headers: target.auth ? { cookie } : {},
        redirect: 'manual',
      });

      if (response.status >= 400 || response.status === 307) {
        console.error(`  ${target.route.padEnd(28)} unreachable (${response.status})`);
        failures += 1;
        continue;
      }

      const { chunkCount, totalGzip, containsThree } = measureHtml(await response.text());
      const kb = totalGzip / 1024;
      const over = kb > target.budgetKb;

      console.log(
        `  ${target.route.padEnd(28)} ${kb.toFixed(1).padStart(6)}K ${String(target.budgetKb).padStart(6)}K   ` +
          `${over ? 'OVER' : 'ok'}  (${chunkCount} chunks)`,
      );

      if (over) failures += 1;

      // Non-negotiable regardless of the size budget: the 3D scene must stay
      // out of every route's initial bundle, or authentication waits on it.
      if (containsThree) {
        console.error(
          `  ✗ ${target.route}: three.js is in the INITIAL bundle — it must be lazy-loaded`,
        );
        failures += 1;
      }
    }
  } finally {
    server.kill('SIGTERM');
  }

  if (failures > 0 && !reportOnly) {
    console.error(
      `\n${failures} bundle budget failure(s). Investigate before raising a budget — ` +
        'see docs/design/performance-budget.md §Reduction paths.',
    );
    process.exit(1);
  }

  console.log(reportOnly ? '\nReport only — not enforcing.' : '\nAll routes within budget.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
