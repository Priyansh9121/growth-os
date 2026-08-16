/**
 * Build the two scripts that run on a CUSTOMER'S website.
 *
 * WHY THIS IS ITS OWN BUILD, AND ITS OWN BUDGET
 * `embed.js` and `track.js` are the only Growth OS code that executes on
 * someone else's domain. They must not be able to grow the way an application
 * bundle grows — nobody notices 40 KB in a dashboard, and everybody notices it
 * on a marketing site's Lighthouse score.
 *
 * So they are plain ES5-compatible IIFEs, minified with esbuild, with a HARD
 * BUDGET enforced here. No React, no framework, no shared imports: a shared
 * import is how a 600-byte loader quietly acquires a dependency tree.
 *
 * The measured sizes are written to docs/design/performance-budget.md by hand,
 * with the command that produced them.
 */

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(repoRoot, 'apps/web/scripts');

/**
 * ⚠️ MUST MATCH `EMBED_SCRIPT_PATH` and `TRACKING_SCRIPT_PATH` in
 * `packages/contracts/src/forms/public-scripts.ts`, which is what the snippet
 * an operator copies is built from. This file cannot import TypeScript, so the
 * agreement is proved by the embed E2E test rather than by the type system —
 * and it needed proving: the snippet advertised `/embed.js` for a whole stage
 * while the build wrote `/scripts/embed.js`.
 */
const outDir = resolve(repoRoot, 'apps/web/public/scripts');

/**
 * Staged sources go to a TEMPORARY directory, never to `public/`.
 *
 * They used to be written beside the output as `.embed.js.staged.js` and never
 * removed — which meant an unminified copy of both scripts, comments and all,
 * was served to anyone who asked for it. Nothing in `public/` is private, so
 * nothing that is not deliberately published belongs there.
 */
const stageDir = mkdtempSync(resolve(tmpdir(), 'growth-os-public-scripts-'));

/**
 * Budgets in GZIPPED bytes.
 *
 * `embed.js` inserts an iframe and listens for one message; if it ever
 * approaches 2 KB, something has been added that belongs inside the frame.
 * `track.js` reads a URL and writes one storage key.
 */
const BUDGETS = {
  'embed.js': 2048,
  'track.js': 3072,
};

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

mkdirSync(outDir, { recursive: true });

let failed = false;
console.log(`Building public scripts (origin: ${APP_URL})\n`);

for (const [name, budget] of Object.entries(BUDGETS)) {
  const source = resolve(srcDir, name.replace('.js', '.src.js'));
  const target = resolve(outDir, name);

  // The origin is baked in at build time rather than read from the DOM. A
  // script that discovered its own origin from `document.currentScript.src`
  // would follow a customer's CDN rewrite to wherever it pointed.
  const withOrigin = readFileSync(source, 'utf8').replaceAll('__GROWTH_OS_ORIGIN__', APP_URL);
  const staged = resolve(stageDir, name);
  writeFileSync(staged, withOrigin);

  const result = await build({
    entryPoints: [staged],
    bundle: true,
    minify: true,
    format: 'iife',
    // ES2017: every browser a small business's customers actually use, and old
    // enough that no transpilation runtime is needed.
    target: ['es2017'],
    outfile: target,
    legalComments: 'none',
    logLevel: 'silent',
  });

  if (result.errors.length > 0) {
    console.error(`  ✗ ${name}: ${result.errors.map((e) => e.text).join(', ')}`);
    failed = true;
    continue;
  }

  const bytes = readFileSync(target);
  const gzip = gzipSync(bytes, { level: 6 }).length;
  const ok = gzip <= budget;
  if (!ok) failed = true;

  console.log(
    `  ${ok ? '✓' : '✗'} ${name.padEnd(10)} ${String(bytes.length).padStart(5)} B raw  ` +
      `${String(gzip).padStart(5)} B gzip  (budget ${budget} B)`,
  );
}

rmSync(stageDir, { recursive: true, force: true });

if (failed) {
  console.error('\nA public script exceeded its budget. These run on customer websites.');
  process.exit(1);
}

console.log('\nBoth public scripts are within budget.');
