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

  // Stage 3. The worker is a second PROCESS in the monolith, not a second
  // service — so the boundaries that keep it one are probed rather than
  // assumed. A worker that could import the web app, or render, has quietly
  // become a microservice.
  {
    name: 'worker \u2192 next (a worker must not render or serve)',
    file: 'apps/worker/src/__boundary_probe.ts',
    source: "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n",
  },
  {
    name: 'worker \u2192 react',
    file: 'apps/worker/src/__boundary_probe.ts',
    source: "import { useState } from 'react';\nexport const probe = useState;\n",
  },
  {
    name: 'worker \u2192 ui design system',
    file: 'apps/worker/src/__boundary_probe.ts',
    source: "import { cn } from '@growth-os/ui';\nexport const probe = cn;\n",
  },
  {
    name: 'worker \u2192 apps/web (would make it a second service)',
    file: 'apps/worker/src/__boundary_probe.ts',
    source:
      "import { getDependencies } from '../../web/src/server/dependencies';\nexport const probe = getDependencies;\n",
  },

  // -------------------------------------------------------------------------
  // ⚠️ THE NETWORK BOUNDARY (AGENTS.md §5, ADR-0032)
  //
  // The whole SSRF design rests on `@growth-os/net` being the only package that
  // opens a socket. That was a sentence in a document until these probes
  // existed — and a sentence is exactly what `eslint-plugin-boundaries` was
  // before it turned out to enforce nothing.
  //
  // A second socket anywhere is a path around URL admission, address
  // classification, pinned resolution, per-hop redirect revalidation and the
  // body caps. All of it, at once.
  // -------------------------------------------------------------------------
  {
    name: 'crawler → node:http (a second socket)',
    file: 'packages/crawler/src/__boundary_probe.ts',
    source: "import { request } from 'node:http';\nexport const probe = request;\n",
  },
  {
    name: 'crawler → node:dns (resolution outside the pin)',
    file: 'packages/crawler/src/__boundary_probe.ts',
    source: "import { lookup } from 'node:dns';\nexport const probe = lookup;\n",
  },
  {
    name: 'sites → node:https (verification must use safeFetch)',
    file: 'packages/sites/src/__boundary_probe.ts',
    source: "import { request } from 'node:https';\nexport const probe = request;\n",
  },
  {
    name: 'forms → node:net',
    file: 'packages/forms/src/__boundary_probe.ts',
    source: "import { connect } from 'node:net';\nexport const probe = connect;\n",
  },
  {
    name: 'crm → undici (a client that follows redirects)',
    file: 'packages/crm/src/__boundary_probe.ts',
    source: "import { request } from 'undici';\nexport const probe = request;\n",
  },
  {
    name: 'apps/web → axios',
    file: 'apps/web/src/__boundary_probe.ts',
    source: "import axios from 'axios';\nexport const probe = axios;\n",
  },
  {
    name: 'worker → node:https',
    file: 'apps/worker/src/__boundary_probe.ts',
    source: "import { request } from 'node:https';\nexport const probe = request;\n",
  },
  {
    name: 'agents → ui (a service is not an application layer)',
    file: 'packages/agents/src/__boundary_probe.ts',
    source: "import { Button } from '@growth-os/ui';\nexport const probe = Button;\n",
  },
  {
    name: 'guardrails → node:http (a pure package must not grow a socket)',
    file: 'packages/guardrails/src/__boundary_probe.ts',
    source: "import { request } from 'node:http';\nexport const probe = request;\n",
  },
  {
    name: 'guardrails → database (purity is what lets it run pre-persist)',
    file: 'packages/guardrails/src/__boundary_probe.ts',
    source:
      "import { getDatabase } from '@growth-os/database';\nexport const probe = getDatabase;\n",
  },
  {
    name: 'crawler → dynamic import of node:http',
    file: 'packages/crawler/src/__boundary_probe.ts',
    source: "export const probe = () => import('node:http');\n",
  },
  // The audit layer. "It cannot fetch a page" is the claim packages/seo exists
  // to make provable rather than commented (ADR-0071); these are the proof.
  {
    name: 'seo → node:http (an audit must not be able to fetch anything)',
    file: 'packages/seo/src/__boundary_probe.ts',
    source: "import { request } from 'node:http';\nexport const probe = request;\n",
  },
  {
    name: 'seo → net (the legitimate socket is still a socket)',
    file: 'packages/seo/src/__boundary_probe.ts',
    source: "import { safeFetch } from '@growth-os/net';\nexport const probe = safeFetch;\n",
  },
  {
    name: "seo → crawler (the audit reads the crawler's tables, not its code)",
    file: 'packages/seo/src/__boundary_probe.ts',
    source:
      "import { recordLinks } from '@growth-os/crawler';\nexport const probe = recordLinks;\n",
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
