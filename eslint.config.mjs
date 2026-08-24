/**
 * ESLint flat configuration.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Two jobs, in order of importance:
 *
 *  1. **Enforce the module boundaries from ADR-0001.** An architecture rule
 *     that is only written down is a rule that will be broken under deadline,
 *     so an illegal import is a lint failure — and the rules themselves are
 *     verified by `scripts/verify-boundaries.mjs`.
 *  2. Catch the correctness and security mistakes TypeScript cannot.
 *
 * @see docs/architecture/module-boundaries.md
 * @see docs/decisions/ADR-0001-architecture-style.md
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Generated, vendored or build output. Never linted.
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/migrations/**',
      '**/*.d.ts',
      'apps/web/next-env.d.ts',
      // Minified build output of the public scripts. The SOURCES in
      // apps/web/scripts/*.src.js are linted; linting their minified form
      // reports on esbuild's choices, not ours.
      'apps/web/public/scripts/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused variables are usually a mistake; a leading underscore is the
      // explicit "I know, this is intentional" escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` defeats the type system precisely where we rely on it most
      // (tenancy, authorization). A warning rather than an error so that
      // third-party interop does not block a build, but it stays visible.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Type-only imports must be marked, so `verbatimModuleSyntax` cannot
      // accidentally emit a runtime import of a types-only module.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // `console` is fine on the server (structured logging arrives with the
      // observability package); `console.log` in shipped client code is not.
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ---------------------------------------------------------------------------
  // MODULE BOUNDARIES — the mechanical enforcement of ADR-0001.
  //
  // Implemented with `no-restricted-imports` rather than a boundaries plugin.
  //
  // WHY. `eslint-plugin-boundaries` was tried first and could not resolve
  // workspace packages in this setup: `@growth-os/*` specifiers resolve through
  // npm's node_modules symlinks to `exports` entries pointing at TypeScript
  // source, which its resolver treats as external. The result was a rule that
  // reported nothing — verified by deliberately committing illegal imports and
  // watching lint pass. A boundary rule that cannot fail is worse than no rule,
  // because it manufactures confidence.
  //
  // `no-restricted-imports` operates on the import SPECIFIER STRING, so it
  // needs no module resolution and is deterministic. Every cross-package import
  // in this repo goes through a `@growth-os/*` specifier, and the `../../`
  // patterns below close the relative-path escape hatch.
  //
  // These rules are verified by `scripts/verify-boundaries.mjs`, which writes
  // deliberately illegal imports, asserts lint FAILS, and cleans up. Run by
  // `npm run verify:all`.
  //
  // The allowed edges:
  //     ui         → (nothing internal)
  //     contracts  → (nothing internal)
  //     database   → contracts
  //     auth       → contracts, database
  //     crm        → contracts, database        (NEVER auth — would cycle)
  //     apps/*     → any package, never another app
  // ---------------------------------------------------------------------------

  // A design system that knows about the database is not a design system.
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@growth-os/*'],
              message:
                'packages/ui must not depend on any other internal package (ADR-0001). It is presentation only.',
            },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory. Use a declared dependency.',
            },
          ],
        },
      ],
    },
  },

  // Contracts is the shared vocabulary and sits at the bottom of the graph.
  {
    files: ['packages/contracts/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
          ],
          patterns: [
            {
              group: ['@growth-os/*'],
              message:
                'packages/contracts must depend on nothing internal — it is the vocabulary every other package speaks (ADR-0001).',
            },
            { group: ['next/*'], message: 'Domain packages must not depend on Next.js.' },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  /**
   * The agent platform's services: contracts, database and guardrails only.
   *
   * This package exists BECAUSE guardrails is pure — something has to assemble
   * a corpus from tenant-scoped storage, and it is not going to be the package
   * whose whole value is not needing storage. Importing `ui` or `auth` here
   * would make it a second application layer rather than a service (ADR-0065).
   */
  {
    files: ['packages/agents/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
          ],
          patterns: [
            {
              group: ['@growth-os/auth', '@growth-os/auth/*', '@growth-os/ui', '@growth-os/ui/*'],
              message:
                'packages/agents may depend on contracts, database and guardrails only. Importing auth would create a cycle.',
            },
            { group: ['next/*'], message: 'Domain packages must not depend on Next.js.' },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  /**
   * Guardrails is PURE, and this is what makes that a fact rather than a claim.
   *
   * The package description says it "opens no socket and touches no database"
   * because the comparison corpus is passed in. That design is the only reason
   * a draft can be checked BEFORE it is persisted, which is the moment at which
   * catching a duplicate is still cheap. A single `@growth-os/database` import
   * would quietly convert it into a service that can only run after the fact.
   *
   * The network half is already covered by the global socket rule below; this
   * closes the database and framework halves (ADR-0064).
   */
  {
    files: ['packages/guardrails/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
          ],
          patterns: [
            {
              group: ['@growth-os/*'],
              message:
                'packages/guardrails is pure: it is GIVEN the corpus rather than fetching one, so it can run before an output is persisted (ADR-0064).',
            },
            { group: ['next/*'], message: 'Domain packages must not depend on Next.js.' },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  /**
   * The audit layer, and the reason it is a package rather than a directory.
   *
   * ⚠️ IT MUST NOT BE ABLE TO FETCH ANYTHING. An audit interprets facts that
   * are ALREADY recorded. A rule that could reach the network could decide to
   * go and look at the page itself, and that path would be a second crawler —
   * one with no robots evaluation, no frontier budget and no politeness. The
   * global socket rule below already denies `node:http` here; what this block
   * adds is `@growth-os/net`, which is the legitimate way to open a socket and
   * therefore the one this package must also not have.
   *
   * ⚠️ AND NOT `@growth-os/crawler` EITHER, which is the less obvious half.
   * The audit reads the crawler's TABLES, not its code. Depending on the
   * package would let a rule call `fetchPage` transitively, and would couple
   * the interpretation of facts to the implementation that gathered them — so
   * that changing how a page is fetched could change what an audit concludes.
   *
   * The allowance is expressed as a NEGATION rather than a list of forbidden
   * packages, so a package added later is denied by default instead of being
   * silently permitted until somebody remembers to extend a list
   * (ADR-0071).
   */
  {
    files: ['packages/seo/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
          ],
          patterns: [
            {
              group: ['@growth-os/*', '!@growth-os/contracts', '!@growth-os/database'],
              message:
                "packages/seo may depend on contracts and database only. It reads the crawler's tables, not its code, and it must not be able to open a socket (ADR-0071).",
            },
            { group: ['next/*'], message: 'Domain packages must not depend on Next.js.' },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  // database → contracts only.
  {
    files: ['packages/database/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
          ],
          patterns: [
            {
              group: [
                '@growth-os/auth',
                '@growth-os/auth/*',
                '@growth-os/ui',
                '@growth-os/ui/*',
                '@growth-os/crm',
                '@growth-os/crm/*',
              ],
              message:
                'packages/database may depend on @growth-os/contracts only. Dependencies point downward (ADR-0001).',
            },
            { group: ['next/*'], message: 'Domain packages must not depend on Next.js.' },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  // auth → contracts, database.
  {
    files: ['packages/auth/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
          ],
          patterns: [
            {
              group: ['@growth-os/ui', '@growth-os/ui/*', '@growth-os/crm', '@growth-os/crm/*'],
              message:
                'packages/auth must not depend on the design system or the CRM. Authorization is presentation- and domain-agnostic (ADR-0001).',
            },
            {
              group: ['next/*'],
              message:
                'Domain packages must not depend on Next.js — it must stay hostable by Fastify.',
            },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  // crm → contracts, database. NEVER auth: that would create a cycle and
  // couple the CRM to how authentication happened, which the voice service
  // (Stage 13) will not share.
  {
    files: ['packages/crm/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
            // THE CRM MUST NEVER TOUCH THE FILESYSTEM.
            //
            // Added for CSV import (ADR-0023 §6): the uploaded file is parsed
            // from the request body in memory and discarded, so there is no
            // upload directory to leak, scan, or forget to clean up — and no
            // path for a customer's contact list to be written somewhere it
            // can be committed by accident. A rule beats a convention here,
            // because the convenient thing to do under time pressure is to
            // spool the file to /tmp.
            {
              name: 'node:fs',
              message:
                'The CRM must never touch the filesystem. Customer files are parsed in memory and discarded (ADR-0023 §6).',
            },
            {
              name: 'node:fs/promises',
              message:
                'The CRM must never touch the filesystem. Customer files are parsed in memory and discarded (ADR-0023 §6).',
            },
            {
              name: 'fs',
              message: 'The CRM must never touch the filesystem (ADR-0023 §6).',
            },
          ],
          patterns: [
            {
              group: ['@growth-os/auth', '@growth-os/auth/*', '@growth-os/ui', '@growth-os/ui/*'],
              message:
                'packages/crm may depend on @growth-os/contracts and @growth-os/database only. Importing auth would create a cycle (ADR-0011).',
            },
            {
              group: ['next/*'],
              message:
                'Domain packages must not depend on Next.js — it must stay hostable by the worker and voice service.',
            },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  // packages/forms owns the product's first ANONYMOUS PUBLIC WRITE PATH, so its
  // boundaries matter more than most. Same rules as the CRM, plus the CRM
  // itself as an allowed dependency — forms calls `ingestAcquisition` and must
  // never reimplement it.
  {
    files: ['packages/forms/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'Domain packages must not depend on Next.js.' },
            { name: 'react', message: 'Domain packages must not depend on React.' },
            {
              name: 'node:fs',
              message:
                'Lead capture must never touch the filesystem. Same rule as the CRM (ADR-0023 §6).',
            },
            {
              name: 'node:fs/promises',
              message: 'Lead capture must never touch the filesystem.',
            },
            { name: 'fs', message: 'Lead capture must never touch the filesystem.' },
          ],
          patterns: [
            {
              group: ['@growth-os/auth', '@growth-os/auth/*', '@growth-os/ui', '@growth-os/ui/*'],
              message:
                'packages/forms may depend on contracts, crm and database only. Importing auth would create a cycle.',
            },
            {
              group: ['next/*'],
              message: 'Domain packages must not depend on Next.js.',
            },
            {
              group: ['../../*', '**/apps/**'],
              message: 'Imports must not escape the package directory.',
            },
          ],
        },
      ],
    },
  },

  // Apps are runtime hosts: any package, never another app.
  {
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@growth-os/web', '@growth-os/web/*', '**/apps/*/src/**'],
              message:
                'Apps must not import from another app. Share code through a package instead (ADR-0001).',
            },
          ],
        },
      ],
    },
  },

  /**
   * ⚠️ THE NETWORK BOUNDARY — only `@growth-os/net` may open a socket.
   *
   * AGENTS.md §5 states this, and until now nothing enforced it: the rule was a
   * sentence in a document, which is the same category of thing as the
   * `eslint-plugin-boundaries` config that reported nothing. `verify-boundaries`
   * now proves it fails.
   *
   * ⚠️ IMPLEMENTED WITH `no-restricted-syntax`, NOT `no-restricted-imports`,
   * and that is deliberate. Flat config REPLACES rule options wholesale rather
   * than merging them (see the worker block below), so a second
   * `no-restricted-imports` block matching `packages/**` would silently delete
   * every per-package boundary it overlapped. A different rule name cannot
   * collide, so this composes instead of destroying.
   *
   * The point is not that these modules are dangerous in themselves. It is that
   * SSRF defence is a pipeline — URL admission, address classification, pinned
   * resolution, per-hop redirect revalidation, body caps — and a second socket
   * anywhere in the repository is a path around all of it (ADR-0032).
   */
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
    ignores: ['packages/net/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[source.value=/^(node:)?(http|https|net|dns|tls|dgram)(\\/.*)?$/]',
          message:
            'Only @growth-os/net may open a socket. Route the request through safeFetch (ADR-0032, AGENTS.md §5).',
        },
        {
          selector: 'ImportDeclaration[source.value=/^(undici|axios|got|node-fetch|superagent)$/]',
          message:
            'HTTP clients follow redirects around the SSRF layer. Use safeFetch from @growth-os/net (ADR-0032).',
        },
        {
          selector:
            'ImportExpression[source.value=/^(node:)?(http|https|net|dns|tls|dgram)(\\/.*)?$/]',
          message: 'A dynamic import is still a socket. Use @growth-os/net (ADR-0032).',
        },
      ],
    },
  },

  /**
   * The worker is a SECOND PROCESS, not a second service.
   *
   * ⚠️ THIS BLOCK MUST STAY AFTER the generic `apps/**` block above. ESLint
   * flat config does not MERGE rule options — the last matching block replaces
   * them wholesale. Placed before it, these restrictions were silently
   * discarded and the boundary probes proved it: four illegal imports compiled
   * happily.
   *
   * It shares the repository, the packages and the database, and has no
   * network API between it and the web app. These rules are what keep that
   * true: a worker that could import React or Next is one refactor from
   * rendering, and one that could import `apps/web` has stopped being part of
   * the same deployable (ADR-0001, ADR-0030).
   */
  {
    files: ['apps/worker/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'The worker renders nothing.' },
            { name: 'next', message: 'The worker serves no HTTP and renders nothing.' },
          ],
          patterns: [
            {
              group: ['next/*', '@growth-os/ui', '@growth-os/ui/*'],
              message: 'The worker renders nothing and serves no HTTP.',
            },
            {
              group: ['**/apps/web/**', '../../web/**'],
              message:
                'The worker must not import the web app. Share through a package — importing an app makes this a second service (ADR-0030).',
            },
          ],
        },
      ],
      // Printing IS a worker's interface; it has no other output channel.
      'no-console': 'off',
    },
  },

  // Tests may be looser: non-null assertions on fixtures are noise-reduction,
  // not risk, and casting is often required to exercise a boundary.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/testing/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  // The seed script is the single sanctioned exception to `database -/-> crm`.
  // It is development-only tooling, not library code, and it imports the CRM
  // DYNAMICALLY so no static dependency edge is created — the packages remain
  // independently loadable. Narrowed to this one file rather than the whole
  // scripts directory.
  {
    files: ['packages/database/src/scripts/seed.ts', 'packages/database/src/scripts/seed-crm.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Scripts run in a terminal; printing IS their interface. Plain `.mjs` files
  // also need Node globals declared explicitly — the `**/*.{ts,tsx}` block
  // above does not match them.
  {
    files: [
      'packages/database/src/scripts/**/*.ts',
      'scripts/**/*.mjs',
      // `tests/e2e/database-url.mjs` is `.mjs` so the Playwright config, the
      // global setup and the `verify:e2e` preflight can all import one copy of
      // the database URL. It runs in Node like the rest of this block.
      'tests/**/*.mjs',
      '*.mjs',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-console': 'off' },
  },

  /**
   * The two scripts that run on a CUSTOMER'S WEBSITE.
   *
   * Plain ES5-compatible browser IIFEs, deliberately not TypeScript and
   * deliberately not modules: they must minify to a few hundred bytes with no
   * runtime and no imports (ADR-0027).
   *
   * `no-empty` is off because an empty `catch` is the CORRECT handling here —
   * `sessionStorage` throws in private mode and when quota is exhausted, and
   * the right response is to carry on without attribution rather than to break
   * a stranger's page. The comment inside each block says so.
   */
  {
    files: ['apps/web/scripts/*.src.js'],
    languageOptions: {
      ecmaVersion: 2017,
      sourceType: 'script',
      globals: globals.browser,
    },
    rules: {
      'no-empty': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
);
