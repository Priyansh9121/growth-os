/**
 * Database connection and the tenant-scoped transaction helper.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Owns the connection pool and provides the ONLY sanctioned way to read or
 * write tenant data: `withTenantTransaction`.
 *
 * @see docs/security/tenant-isolation.md
 * @see docs/decisions/ADR-0003-database-and-orm.md
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { loadEnv } from '@growth-os/contracts/env';
import * as schema from './schema/index';

export type Database = ReturnType<typeof createDatabase>;

/**
 * The transaction handle passed to `withTenantTransaction`.
 *
 * Deriving the type from Drizzle's own transaction callback keeps it correct
 * across Drizzle upgrades rather than restating a shape that could silently
 * drift.
 */
export type TenantTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface CreateDatabaseOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  /** Emit SQL to stdout. Development only. */
  readonly debug?: boolean;
}

export function createDatabase({
  connectionString,
  maxConnections = 10,
  debug = false,
}: CreateDatabaseOptions) {
  const client = postgres(connectionString, {
    max: maxConnections,
    // Fail fast on an unreachable database rather than hanging a request
    // thread until the platform's own timeout fires.
    connect_timeout: 10,
    idle_timeout: 30,
    // Transforms are deliberately off: Drizzle already maps snake_case columns
    // to camelCase properties, and a second transform layer would corrupt the
    // raw `SET LOCAL` statements below.
    onnotice: debug ? console.info : () => {},
  });

  return drizzle(client, { schema, logger: debug });
}

let cached: Database | null = null;

/**
 * The process-wide database handle.
 *
 * Cached because Next.js re-evaluates modules on hot reload in development;
 * without this, every reload would open a new pool and exhaust PostgreSQL's
 * connection limit within a few minutes of editing.
 */
export function getDatabase(): Database {
  if (cached) return cached;
  const env = loadEnv();
  cached = createDatabase({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DATABASE_POOL_MAX,
    debug: env.LOG_LEVEL === 'trace',
  });
  return cached;
}

/** Test-only: replace the process-wide handle. */
export function setDatabase(db: Database | null): void {
  cached = db;
}

/**
 * PostgreSQL setting read by every row-level security policy.
 *
 * Namespaced with a dot so PostgreSQL treats it as a customised option rather
 * than rejecting it as an unknown parameter.
 */
export const TENANT_SETTING = 'app.workspace_id';

/**
 * Run `fn` inside a transaction scoped to one workspace.
 *
 * WHY THIS EXISTS
 * Application-level `WHERE workspace_id = ?` filtering is necessary but not
 * sufficient: one forgotten clause, once, is a cross-tenant data breach. This
 * helper sets a transaction-local setting that RLS policies filter on, so a
 * forgotten clause returns zero rows instead of another tenant's data.
 *
 * WHY `SET LOCAL` AND NOT `SET`
 * `SET LOCAL` is scoped to the transaction and is reverted on commit or
 * rollback. A plain `SET` persists for the life of the *connection* — and with
 * a pool, that connection is handed to the next request, which would inherit
 * the previous tenant's scope. That is a catastrophic and very quiet bug, so
 * the distinction is the single most important line in this file.
 *
 * WHY `set_config` RATHER THAN INTERPOLATION
 * `SET LOCAL` does not accept bind parameters, so a naive implementation
 * string-concatenates the workspace ID into SQL. `set_config(name, value,
 * is_local)` is a function call and takes real parameters, so the value cannot
 * be interpreted as SQL. The `is_local = true` argument is what makes it
 * equivalent to `SET LOCAL`.
 *
 * OPERATIONAL PRECONDITION
 * PostgreSQL exempts superusers and table owners from RLS. If the application
 * connects as the table owner, every policy here is silently inert. See
 * docs/security/tenant-isolation.md; this is asserted by an integration test
 * rather than trusted to documentation.
 *
 * @param workspaceId The tenant boundary. Must already be authorized —
 *   this function enforces isolation, it does NOT decide access.
 */
export async function withTenantTransaction<T>(
  db: Database,
  workspaceId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${TENANT_SETTING}, ${workspaceId}, true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` in a transaction with NO tenant scope.
 *
 * Required for genuinely cross-tenant operations: authenticating a user (whose
 * workspaces are not yet known), resolving memberships, and platform
 * administration.
 *
 * Named `unscoped` rather than something neutral so that its use is
 * conspicuous in review and greppable in an audit. Every call site should be
 * justifiable in one sentence.
 */
export async function withUnscopedTransaction<T>(
  db: Database,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

export { schema };
