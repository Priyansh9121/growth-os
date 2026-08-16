/**
 * Vitest workspace configuration.
 *
 * Three projects with different requirements, so that a developer without a
 * database can still run the fast, deterministic majority of the suite:
 *
 *   unit         — pure logic. No I/O. Milliseconds. Always runnable.
 *   integration  — real PostgreSQL. SKIPS ITSELF when TEST_DATABASE_URL is
 *                  unset, rather than failing, so a missing database is a
 *                  reduced suite and not a broken checkout.
 *   web          — React components in jsdom.
 *
 * @see docs/engineering/testing-strategy.md
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            // `server-only` is a build-time marker with no runtime behaviour,
            // and is not resolvable outside the Next.js bundler. Without the
            // alias, any test that imports a server module fails on the import
            // rather than on what it is testing.
            'server-only': resolve(import.meta.dirname, 'tests/setup/server-only-stub.ts'),
          },
        },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'packages/*/src/**/*.integration.test.ts',
            'apps/*/src/**/*.integration.test.ts',
            'tests/integration/**/*.test.ts',
          ],
          // Argon2 hashing is intentionally slow (~50ms each) and these tests
          // exercise the real login path, so the default 5s timeout is tight.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Tests share one database and TRUNCATE between cases, so they must
          // not run concurrently against each other.
          fileParallelism: false,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./tests/setup/web-setup.ts'],
          include: ['apps/web/src/**/*.test.tsx', 'packages/ui/src/**/*.test.tsx'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // Generated, vendored or trivially-typed files carry no risk and would
      // dilute the signal from the code that does.
      exclude: [
        '**/node_modules/**',
        '**/*.config.*',
        '**/migrations/**',
        '**/*.d.ts',
        '**/index.ts',
        'apps/web/.next/**',
        'packages/database/src/scripts/**',
      ],
    },
  },
});
