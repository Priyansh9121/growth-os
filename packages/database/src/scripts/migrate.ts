/**
 * Migration runner.
 *
 * Applies every pending migration in `migrations/` inside a transaction,
 * tracked by Drizzle's own journal table. Idempotent: running it twice is a
 * no-op.
 *
 * Run with:  npm run db:migrate
 *
 * @see docs/operations/migrations.md
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. See .env.example.');
  }

  // A dedicated single connection, separate from the application pool: the
  // migrator takes advisory locks, and sharing a pooled connection with
  // application traffic during a migration is asking for contention.
  const client = postgres(connectionString, { max: 1, onnotice: () => {} });

  try {
    console.log(`Applying migrations from ${migrationsFolder}`);
    await migrate(drizzle(client), { migrationsFolder });
    console.log('Migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
