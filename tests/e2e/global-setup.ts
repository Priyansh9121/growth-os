/**
 * E2E global setup — migrate and seed the browser-test database.
 *
 * Runs once before the suite. The E2E database is separate from the
 * development one so a test run cannot destroy work in progress; the seed is
 * destructive by design.
 */

import { execFileSync } from 'node:child_process';

export default function globalSetup(): void {
  const databaseUrl =
    process.env['E2E_DATABASE_URL'] ??
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://growth_os:growth_os@127.0.0.1:5432/growth_os_test';

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SEED_PASSWORD: 'DevOnly!Growth0S',
    // The seed script refuses to run when NODE_ENV=production, which is
    // correct — force development here explicitly.
    NODE_ENV: 'development',
  };

  console.info('[e2e] migrating and seeding', databaseUrl.replace(/:[^:@]*@/, ':***@'));
  execFileSync('npm', ['run', 'db:migrate'], { env, stdio: 'inherit' });
  execFileSync('npm', ['run', 'db:seed'], { env, stdio: 'inherit' });
}
