#!/usr/bin/env node
/**
 * Prove that `.gitignore` does not hide first-party source.
 *
 * WHY THIS EXISTS
 * The dangerous `.gitignore` mistake is not a rule that ignores too little —
 * that gets noticed immediately. It is a rule that ignores too much, silently.
 * An unanchored `models/` matches at EVERY depth, so it would swallow
 * `packages/database/src/models/` without a word. The author sees a clean
 * working tree, commits, and the code is simply gone from the repository.
 *
 * This script asserts three properties:
 *
 *   1. No path that currently exists under a first-party source directory is
 *      ignored.
 *   2. A set of PROBE paths — plausible future directories whose names collide
 *      with common ignore patterns — would not be ignored if created.
 *   3. Nothing dangerous (an .env file, a key, node_modules) is tracked.
 *
 * Property 2 is the important one: it catches the mistake BEFORE the directory
 * exists, which is the only time catching it is cheap.
 *
 * Run by `npm run verify:all`.
 *
 * @see docs/engineering/gitignore-rationale.md
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Is `path` ignored?
 *
 * `git check-ignore` exits 0 when the path IS ignored and 1 when it is not,
 * so a thrown error means "not ignored".
 */
function isIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
const fail = (message) => {
  console.error(`  ✗ ${message}`);
  failures += 1;
};

// ---------------------------------------------------------------------------
// 1. Nothing under a first-party source root may be ignored.
// ---------------------------------------------------------------------------
console.log('Checking existing first-party source is not ignored…');

const SOURCE_ROOTS = ['apps', 'packages', 'docs', 'scripts', 'tests', 'infrastructure'];
let checkedFiles = 0;

for (const root of SOURCE_ROOTS) {
  if (!existsSync(resolve(repoRoot, root))) continue;

  // `--others --ignored --exclude-standard` lists untracked files that ARE
  // ignored — precisely the set that should be empty under a source root.
  const ignoredHere = git(['ls-files', '--others', '--ignored', '--exclude-standard', root])
    .split('\n')
    .filter(Boolean)
    // Legitimately ignored, even under a source root.
    .filter((path) => !path.includes('node_modules/'))
    .filter((path) => !path.includes('/.next/'))
    .filter((path) => !path.endsWith('.tsbuildinfo'))
    .filter((path) => !path.includes('next-env.d.ts'))
    .filter((path) => !path.includes('/coverage/'))
    .filter((path) => !path.endsWith('.DS_Store'))
    // BUILD OUTPUT of the public scripts (Stage 3). Generated from the tracked
    // sources in `apps/web/scripts/*.src.js`, with the deployment's origin
    // baked in — committing it would ship whichever origin the last developer
    // had configured.
    //
    // Narrowed to the exact build directory rather than to `*.js`, because the
    // SOURCES are the most security-sensitive files in the repository and a
    // broader exemption would stop this check noticing if one were hidden.
    .filter((path) => !path.startsWith('apps/web/public/scripts/'));

  for (const path of ignoredHere) {
    fail(`first-party path is IGNORED: ${path}`);
  }

  checkedFiles += git(['ls-files', root]).split('\n').filter(Boolean).length;
}

console.log(`  ✓ ${checkedFiles} tracked files across ${SOURCE_ROOTS.length} source roots`);

// ---------------------------------------------------------------------------
// 2. Probe paths that DO NOT EXIST YET but plausibly will.
//
// Each name deliberately collides with a common ignore pattern. If a future
// contributor adds an unanchored rule, this catches it on their commit rather
// than after the code has vanished.
// ---------------------------------------------------------------------------
console.log('Checking plausible future source paths would not be ignored…');

const PROBES = [
  // The canonical example from the brief: `models/` unanchored would eat this.
  'packages/database/src/models/user.ts',
  'apps/api/src/models/contact.ts',
  // `build/` and `dist/` unanchored would eat these.
  'packages/ui/src/build/tokens.ts',
  'packages/contracts/src/dist/schema.ts',
  // `logs/` unanchored would eat a logging module.
  'packages/observability/src/logs/logger.ts',
  // `temp/`, `tmp/`, `cache/` as legitimate module names.
  'packages/worker/src/cache/strategy.ts',
  'apps/web/src/lib/tmp/formatter.ts',
  // `test-results/` vs a results domain model.
  'packages/seo/src/crawl/results/parser.ts',
  // `coverage/` as a domain concept — SEO keyword coverage is a real feature.
  'packages/seo/src/coverage/keyword-coverage.ts',
  // `out/` as an outbound-integration module.
  'packages/integrations/src/out/webhook.ts',
  // A `.env` schema module must not match the `.env*` secret rules.
  'packages/config/src/env.config.ts',
  // Voice service source under a name that collides with model weights.
  'apps/voice/src/models/turn-detector.ts',
  // Stage 2: CRM-shaped paths. `export/` and `cache/` are plausible modules in
  // a package that will grow import/export and query caching.
  'packages/crm/src/export/csv.ts',
  'packages/crm/src/cache/contact-cache.ts',
  'packages/crm/src/coverage/pipeline-coverage.ts',
  'packages/crm/src/temp/migration-helper.ts',
  'packages/crm/src/logs/activity-log.ts',
  'packages/crm/src/dist/bundled.ts',
  // Stage 2.5. CSV import means real contact lists now pass through developer
  // machines, and the temptation is a blanket `*.csv` rule. These two probes
  // are what stop that: a test fixture and an example file must stay
  // trackable, or a future tightening silently hides them.
  'tests/fixtures/contacts.csv',
  'packages/crm/src/import/fixtures/sample.csv',
  'docs/examples/import-template.csv',
  // `imports/` as a module name, against the `/imports/` customer-data rule —
  // which is anchored precisely so this stays trackable.
  'packages/crm/src/imports/mapper.ts',
  // Stage 3. The embed and tracking SOURCES run on customer websites and are
  // the most security-sensitive files in the repository — a rule that hid one
  // would hide the code we most need reviewed.
  'apps/web/scripts/embed.src.js',
  'apps/web/scripts/track.src.js',
  'packages/forms/src/public/submit.ts',
  'tests/fixtures/forms/sample-submission.json',
];

/**
 * Paths that MUST be ignored.
 *
 * The inverse of the probes above, and just as necessary: a rule that hides
 * nothing is as broken as one that hides source, and only one of those two
 * failures is loud.
 */
const MUST_BE_IGNORED = [
  // A customer's exported contact list, saved next to the code.
  'customer-data/leads.csv',
  'imports/abc-plumbing-contacts.csv',
  'apps/web/customers.export.csv',
  'packages/crm/acme.contacts.csv',
  // Database dumps, wherever someone writes them.
  'growth_os.dump',
  'dumps/nightly.sql.gz',
  // Built output, anchored so it cannot hide the sources above.
  'apps/web/public/scripts/embed.js',
  'apps/web/public/scripts/track.js',
];

for (const probe of PROBES) {
  if (isIgnored(probe)) {
    fail(`a future source path WOULD BE IGNORED: ${probe}`);
  }
}

console.log(`  ✓ ${PROBES.length} probe paths remain trackable`);

// ---------------------------------------------------------------------------
// 3. Nothing dangerous is tracked.
// ---------------------------------------------------------------------------
console.log('Checking no secrets or generated output are tracked…');

const tracked = git(['ls-files']).split('\n').filter(Boolean);

const FORBIDDEN = [
  {
    test: (p) => p === '.env' || (p.startsWith('.env') && !p.includes('.example')),
    label: 'environment file',
  },
  { test: (p) => p.includes('node_modules/'), label: 'dependency' },
  { test: (p) => p.includes('/.next/') || p.startsWith('.next/'), label: 'build output' },
  { test: (p) => /\.(pem|key|p12|pfx|keystore|jks)$/.test(p), label: 'credential material' },
  { test: (p) => /\.(gguf|safetensors|onnx|ckpt)$/.test(p), label: 'model weights' },
  { test: (p) => /\.(dump|sql\.gz)$/.test(p), label: 'database dump' },
  { test: (p) => p.endsWith('.DS_Store'), label: 'OS metadata' },
  { test: (p) => p.endsWith('.log'), label: 'log file' },
];

for (const path of tracked) {
  for (const rule of FORBIDDEN) {
    if (rule.test(path)) fail(`${rule.label} is TRACKED: ${path}`);
  }
}

console.log(`  ✓ ${tracked.length} tracked files, none forbidden`);

// `.env.example` must remain trackable despite the blanket `.env*` deny rule.
// Asked as "is it ignored?" rather than "is it committed?", so the check is
// meaningful before the first commit exists.
if (existsSync(resolve(repoRoot, '.env.example')) && isIgnored('.env.example')) {
  fail('.env.example is IGNORED — the `!.env.example` negation rule is broken');
}

// And the blanket rule must genuinely catch a real secrets file.
if (!isIgnored('.env.local')) {
  fail('.env.local is NOT ignored — secrets could be committed');
}
console.log('Checking customer data and dumps ARE ignored…');
let ignoredCount = 0;
for (const path of MUST_BE_IGNORED) {
  if (isIgnored(path)) {
    ignoredCount += 1;
  } else {
    fail(`${path} is NOT ignored — a customer's data could be committed`);
  }
}
if (ignoredCount === MUST_BE_IGNORED.length) {
  console.log(`  ✓ ${ignoredCount} customer-data paths are ignored`);
}

if (!isIgnored('.env')) {
  fail('.env is NOT ignored — secrets could be committed');
}

if (failures > 0) {
  console.error(
    `\n${failures} gitignore safety problem(s). See docs/engineering/gitignore-rationale.md.`,
  );
  process.exit(1);
}

console.log('\nGitignore is safe: no first-party source is hidden, no secrets are tracked.');
