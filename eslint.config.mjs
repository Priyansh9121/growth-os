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
    files: ['packages/database/src/scripts/**/*.ts', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-console': 'off' },
  },
);
