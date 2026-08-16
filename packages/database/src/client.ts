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

/**
 * Raw clients, keyed by the Drizzle handle wrapping them.
 *
 * WHY THIS REGISTRY EXISTS
 * `drizzle(client)` returns a handle that does not expose the pool underneath
 * it. Before this, the `postgres` client was captured in a closure and
 * unreachable — so **nothing in the process could close the pool**, and a
 * finite program like `worker --once` completed all its work and then hung
 * forever on an idle connection holding the event loop open.
 *
 * A `WeakMap` rather than a `Map` deliberately: a handle nobody holds should be
 * collectable, and a strong registry would make every database ever created
 * immortal — turning a leak of connections into a leak of memory as well.
 */
const pools = new WeakMap<object, ReturnType<typeof postgres>>();

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

  const db = drizzle(client, { schema, logger: debug });
  pools.set(db, client);
  return db;
}

let cached: Database | null = null;

/**
 * The process-wide database handle.
 *
 * Cached because Next.js re-evaluates modules on hot reload in development;
 * without this, every reload would open a new pool and exhaust PostgreSQL's
 * connection limit within a few minutes of editing.
 *
 * ⚠️ WHO OWNS THIS POOL — the answer matters, so it is written down.
 *
 *   The PROCESS ENTRY POINT owns it. Nothing else may close it.
 *
 *   - `apps/web` is a long-running server and **never** closes it. A request
 *     handler that closed the pool would break every subsequent request.
 *   - `apps/worker` DOES close it, because `--once` is a finite program that
 *     must be able to end, and the loop mode closes after its final pass.
 *   - Tests own whatever they create and close it in `afterAll`.
 *
 * A service, a route or a job handler that finds itself wanting to call
 * `closeDatabase` is reaching outside its layer.
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

/**
 * Close a handle's connection pool and release the event loop.
 *
 * Called by a process ENTRY POINT at the end of its life — see the ownership
 * note on `getDatabase`. With no argument it closes the process-wide handle.
 *
 * PROPERTIES, each of which a caller depends on:
 *
 *  - **Idempotent.** The registry entry is removed BEFORE the await, so a
 *    second call — including one racing the first — finds nothing and returns.
 *  - **Safe when never initialised.** No handle, no pool, no error.
 *  - **Does not throw because it is already closed.** A shutdown path that
 *    fails while shutting down turns a clean exit into a crash, and the
 *    process is ending regardless.
 *
 * There is deliberately no `process.exit()` anywhere near this. Forcing exit
 * would hide exactly the resource-ownership bug this function exists to fix,
 * and would truncate an in-flight transaction rather than letting it finish.
 */
export async function closeDatabase(db?: Database | null): Promise<void> {
  const target = db ?? cached;
  if (!target) return;

  // Clear the cache first: a caller that re-enters `getDatabase` while the
  // close is in flight must get a NEW pool, not the one being torn down.
  if (target === cached) cached = null;

  const client = pools.get(target);
  if (!client) return;
  // Synchronous delete before the await — this is what makes a concurrent
  // second call a no-op rather than a double close.
  pools.delete(target);

  try {
    // `timeout: 5` waits briefly for in-flight queries rather than severing
    // them. A job mid-transaction should finish or roll back cleanly.
    await client.end({ timeout: 5 });
  } catch {
    // Already closed, or the socket died first. The pool is gone either way,
    // and a shutdown path must not fail while shutting down.
  }
}

/**
 * Test-only: replace the process-wide handle.
 *
 * ⚠️ Does NOT close the handle it replaces — the caller owns that, and closing
 * someone else's pool from a setter is precisely the kind of hidden lifecycle
 * this module now avoids. Tests that swap in a real database should
 * `closeDatabase(theirs)` themselves.
 */
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
