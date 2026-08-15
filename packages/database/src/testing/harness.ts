/**
 * Integration test harness.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Provides a real PostgreSQL database to integration tests, and — critically —
 * a connection as a RESTRICTED, NON-OWNER role, because that is the only way to
 * genuinely exercise row-level security.
 *
 * WHY THE RESTRICTED ROLE MATTERS MORE THAN ANYTHING ELSE HERE
 * PostgreSQL exempts superusers from RLS, and exempts table owners unless
 * FORCE is set. A test that connects as the migration/owner role would pass
 * every isolation assertion while proving nothing about production. This
 * harness creates a separate role with no special privileges and connects as
 * that — so the tests fail if the policies are wrong, which is the entire
 * point of writing them.
 *
 * @see docs/security/tenant-isolation.md
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as schema from '../schema/index.js';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Password for the throwaway test role. Local test databases only. */
const APP_ROLE = 'growth_os_app_test';
const APP_ROLE_PASSWORD = 'test-only-not-a-secret';

export interface TestHarness {
  /** Connected as the OWNER. Used for setup and teardown; RLS does not apply. */
  readonly owner: ReturnType<typeof drizzle<typeof schema>>;
  /** Connected as the RESTRICTED role. RLS applies. Assert isolation here. */
  readonly app: ReturnType<typeof drizzle<typeof schema>>;
  readonly truncate: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Is an integration database configured?
 *
 * Integration tests SKIP rather than fail when it is not, so a contributor
 * without PostgreSQL gets a reduced suite instead of a broken checkout.
 */
export function hasTestDatabase(): boolean {
  return Boolean(process.env['TEST_DATABASE_URL']);
}

export async function createTestHarness(): Promise<TestHarness> {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (!connectionString) {
    throw new Error('TEST_DATABASE_URL is not set. Guard with hasTestDatabase().');
  }

  const ownerClient = postgres(connectionString, { max: 2, onnotice: () => {} });
  const owner = drizzle(ownerClient, { schema });

  await migrate(drizzle(ownerClient), { migrationsFolder });

  // Provision the restricted role. Idempotent so repeated runs are safe.
  //
  // `sql.raw` rather than bind parameters: a `DO $$ ... $$` block is an
  // anonymous function body, not a statement, so PostgreSQL cannot infer
  // parameter types inside it ("could not determine data type of parameter").
  // Interpolation is safe here specifically because both values are
  // module-level constants under our control — never user input. Anything
  // reaching this code from outside must use bind parameters.
  await owner.execute(
    sql.raw(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
        END IF;
      END
      $$;
    `),
  );

  // Exactly the privileges the application needs, and nothing more. Notably
  // NOT the owner, so RLS is enforced against it.
  await owner.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`));
  await owner.execute(
    sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`),
  );
  await owner.execute(
    sql.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`),
  );

  const appUrl = new URL(connectionString);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_ROLE_PASSWORD;

  const appClient = postgres(appUrl.toString(), { max: 2, onnotice: () => {} });
  const app = drizzle(appClient, { schema });

  async function truncate(): Promise<void> {
    // CASCADE follows foreign keys; RESTART IDENTITY resets sequences so IDs
    // are stable across runs. Run as owner — the app role must not be able to
    // truncate, and if it could, that would itself be a finding.
    await owner.execute(
      sql`TRUNCATE TABLE audit_events, agency_memberships, memberships, sessions, workspaces, agencies, users RESTART IDENTITY CASCADE`,
    );
  }

  async function close(): Promise<void> {
    await Promise.all([appClient.end(), ownerClient.end()]);
  }

  return { owner, app, truncate, close };
}

/**
 * Confirm the app role is genuinely subject to RLS.
 *
 * Called by the isolation suite BEFORE its assertions. Without this check a
 * misconfigured harness (connecting as owner or superuser) would make every
 * isolation test pass vacuously — the worst possible failure mode for a
 * security test.
 */
export async function assertRestrictedRole(harness: TestHarness): Promise<void> {
  const result = await harness.app.execute<{ is_superuser: boolean; current_role: string }>(sql`
    SELECT rolsuper AS is_superuser, current_user AS current_role
    FROM pg_roles WHERE rolname = current_user
  `);

  const row = result[0];
  if (!row) throw new Error('Could not determine the current database role.');
  if (row.is_superuser) {
    throw new Error(
      'The test role is a superuser, which is EXEMPT from row-level security. ' +
        'Every isolation assertion would pass vacuously.',
    );
  }
  if (row.current_role !== APP_ROLE) {
    throw new Error(`Expected to be connected as ${APP_ROLE}, got ${row.current_role}.`);
  }
}
