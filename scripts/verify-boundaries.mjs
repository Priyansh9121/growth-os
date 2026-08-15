#!/usr/bin/env node
/**
 * Prove the module-boundary lint rules actually fail.
 *
 * WHY THIS SCRIPT EXISTS
 * A lint rule that is misconfigured reports nothing and looks exactly like a
 * codebase with no violations. That is how we discovered
 * `eslint-plugin-boundaries` was silently passing every illegal import in this
 * repository — the rule was "enabled", produced no output, and enforced
 * nothing.
 *
 * So the boundary rules are themselves tested: this writes deliberately
 * illegal imports, asserts that ESLint FAILS on each one, and removes them.
 * If a probe passes lint, the boundary is not being enforced and this script
 * exits non-zero.
 *
 * Run by `npm run verify:all`.
 *
 * @see docs/architecture/module-boundaries.md
 * @see eslint.config.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each probe is an import that MUST be rejected by the boundary rules. */
const PROBES = [
  {
    name: 'ui → database',
    file: 'packages/ui/src/__boundary_probe.ts',
    source:
      "import { getDatabase } from '@growth-os/database';\nexport const probe = getDatabase;\n",
  },
  {
    name: 'ui → contracts',
    file: 'packages/ui/src/__boundary_probe.ts',
    source: "import type { Actor } from '@growth-os/contracts';\nexport type Probe = Actor;\n",
  },
  {
    name: 'contracts → database',
    file: 'packages/contracts/src/__boundary_probe.ts',
    source:
      "import { getDatabase } from '@growth-os/database';\nexport const probe = getDatabase;\n",
  },
  {
    name: 'contracts → next',
    file: 'packages/contracts/src/__boundary_probe.ts',
    source: "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n",
  },
  {
    name: 'database → auth',
    file: 'packages/database/src/__boundary_probe.ts',
    source: "import { hashPassword } from '@growth-os/auth';\nexport const probe = hashPassword;\n",
  },
  {
    name: 'auth → ui',
    file: 'packages/auth/src/__boundary_probe.ts',
    source: "import { cn } from '@growth-os/ui';\nexport const probe = cn;\n",
  },
  {
    name: 'auth → next',
    file: 'packages/auth/src/__boundary_probe.ts',
    source: "import { cookies } from 'next/headers';\nexport const probe = cookies;\n",
  },
  {
    name: 'crm → auth (would cycle)',
    file: 'packages/crm/src/__boundary_probe.ts',
    source: "import { hashPassword } from '@growth-os/auth';\nexport const probe = hashPassword;\n",
  },
  {
    name: 'crm → ui',
    file: 'packages/crm/src/__boundary_probe.ts',
    source: "import { cn } from '@growth-os/ui';\nexport const probe = cn;\n",
  },
  {
    name: 'crm → next',
    file: 'packages/crm/src/__boundary_probe.ts',
    source: "import { cookies } from 'next/headers';\nexport const probe = cookies;\n",
  },
  {
    name: 'database → crm (inverted dependency)',
    file: 'packages/database/src/__boundary_probe.ts',
    source:
      "import { createContact } from '@growth-os/crm';\nexport const probe = createContact;\n",
  },
  {
    name: 'auth → crm (inverted dependency)',
    file: 'packages/auth/src/__boundary_probe.ts',
    source:
      "import { createContact } from '@growth-os/crm';\nexport const probe = createContact;\n",
  },
  {
    name: 'ui → crm',
    file: 'packages/ui/src/__boundary_probe.ts',
    source:
      "import { createContact } from '@growth-os/crm';\nexport const probe = createContact;\n",
  },
  {
    name: 'package escaping its directory with a relative path',
    file: 'packages/auth/src/__boundary_probe.ts',
    source: "import { cn } from '../../ui/src/lib/cn';\nexport const probe = cn;\n",
  },

  // Stage 2.5. The lifecycle services are the most privileged code in the
  // product — they are the only paths that can mutate the append-only timeline
  // — so the boundaries around them are worth probing explicitly rather than
  // assuming the package-level rules already cover them.
  {
    name: 'crm ingestion → next (would couple the ingestion boundary to HTTP)',
    file: 'packages/crm/src/ingestion/__boundary_probe.ts',
    source: "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n",
  },
  {
    name: 'crm import → node:fs (the CSV path must never touch disk)',
    file: 'packages/crm/src/import/__boundary_probe.ts',
    source: "import { writeFileSync } from 'node:fs';\nexport const probe = writeFileSync;\n",
  },
  {
    name: 'ui → crm lifecycle services',
    file: 'packages/ui/src/__boundary_probe.ts',
    source: "import { eraseContact } from '@growth-os/crm';\nexport const probe = eraseContact;\n",
  },
];

let failures = 0;

for (const probe of PROBES) {
  const absolute = resolve(repoRoot, probe.file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, probe.source, 'utf8');

  let rejected = false;
  try {
    execFileSync('npx', ['eslint', probe.file], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    // Exit code 0 means lint passed — the boundary was NOT enforced.
  } catch {
    rejected = true;
  } finally {
    rmSync(absolute, { force: true });
  }

  if (rejected) {
    console.log(`  ✓ rejected: ${probe.name}`);
  } else {
    console.error(`  ✗ NOT ENFORCED: ${probe.name} (${probe.file})`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} module boundary/boundaries are not enforced. ` +
      'Fix eslint.config.mjs — an unenforced boundary is worse than none.',
  );
  process.exit(1);
}

console.log(`\nAll ${PROBES.length} module boundaries are enforced.`);
