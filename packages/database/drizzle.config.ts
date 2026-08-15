/**
 * Drizzle Kit configuration.
 *
 * Migrations are GENERATED then REVIEWED as SQL, and are immutable once
 * merged. `drizzle-kit push` is deliberately never used outside a throwaway
 * database: it mutates schema without producing a reviewable artefact, which
 * would let a row-level security change ship without appearing in a diff.
 *
 * @see docs/operations/migrations.md
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: true,
});
