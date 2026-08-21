/**
 * Is the configured database one this project can actually use?
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn "can we run the browser suite against this URL?" into a yes, or into a
 * sentence naming what is wrong. Nothing else. Running the suite is
 * `verify-e2e.mjs`'s job; this only answers the question.
 *
 * ⚠️ WHY A TCP HANDSHAKE WAS NOT ENOUGH, WHICH IS THE WHOLE REASON THIS EXISTS.
 * The check used to be `net.Socket().connect(port)`. Any listener satisfies
 * that. Dev log 0044 hit the consequence: a different, unrelated PostgreSQL was
 * listening on the port in the default URL, the preflight announced
 * "database … reachable on 5432", and the run then died inside `db:migrate`
 * with `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` — whose real cause,
 * `password authentication failed`, was two levels down in a `cause` chain
 * under a headline about SQL.
 *
 * A preflight that says "reachable" about a database it cannot log in to is
 * worse than no preflight: it moves the reader's suspicion away from the
 * credentials, which is where the answer was.
 *
 * ⚠️ WHAT IT CHECKS, AND WHY THAT SET.
 * `global-setup` runs `db:migrate` first, and migrate's FIRST statement is
 * `CREATE SCHEMA IF NOT EXISTS "drizzle"`. So the question is not "does a
 * socket accept" but "can this role create a schema in this database":
 *
 *   1. A real authenticated connection      — catches wrong credentials, a
 *                                             missing database, a non-Postgres
 *                                             service, and nothing listening.
 *   2. `has_database_privilege(… 'CREATE')` — catches a role that connects but
 *                                             cannot do what migrate does next.
 *
 * (2) reuses the distinction `infrastructure/create-app-role.sql` is built
 * around: migrations run as the OWNER precisely because the application role is
 * `NOSUPERUSER NOCREATEDB` and holds no CREATE. Pointing the e2e suite at the
 * restricted role would connect perfectly and fail on the first migration.
 *
 * ⚠️ IT DOES NOT REQUIRE THE SCHEMA TO EXIST. A fresh, empty database is the
 * normal case — `global-setup` migrates and seeds it. Asserting on
 * `drizzle.__drizzle_migrations` would reject exactly the state the suite is
 * designed to start from.
 *
 * @see docs/development-log/0045-a-preflight-that-lied.md
 */

/** SQLSTATE and system error codes worth naming individually. */
const KNOWN_CAUSES = {
  // Wrong password, or a role that exists elsewhere but not here.
  '28P01': (target) => ({
    problem: `authentication failed for user "${target.user}" on ${target.hostPort}`,
    remedy:
      'The port is answering, but with different credentials than configured — ' +
      'very often a DIFFERENT PostgreSQL than the project one. Check which ' +
      'instance owns this port, or set E2E_DATABASE_URL to the right one.',
  }),
  // Role does not exist at all on this server.
  28000: (target) => ({
    problem: `the server on ${target.hostPort} rejected the role "${target.user}"`,
    remedy:
      'This is usually a different PostgreSQL instance that has never heard of ' +
      'this project. Check which instance owns this port.',
  }),
  '3D000': (target) => ({
    problem: `database "${target.database}" does not exist on ${target.hostPort}`,
    remedy:
      'The server is answering but does not have this database — often a ' +
      'different instance on the same port. Create it, or point ' +
      'E2E_DATABASE_URL at the instance that has it.',
  }),
  ECONNREFUSED: (target) => ({
    problem: `nothing is listening on ${target.hostPort}`,
    remedy:
      'Start PostgreSQL, or point E2E_DATABASE_URL at a running one. See infrastructure/README.md.',
  }),
  ENOTFOUND: (target) => ({
    problem: `the host in the database URL does not resolve (${target.hostPort})`,
    remedy: 'Check the hostname in E2E_DATABASE_URL or TEST_DATABASE_URL.',
  }),
  ETIMEDOUT: (target) => ({
    problem: `connecting to ${target.hostPort} timed out`,
    remedy:
      'The address is routable but nothing completed a handshake. Check the port and any firewall.',
  }),
  CONNECT_TIMEOUT: (target) => ({
    problem: `connecting to ${target.hostPort} timed out`,
    remedy:
      'Something is listening but did not complete a PostgreSQL handshake — check it is actually PostgreSQL.',
  }),
};

/**
 * Turn a driver error into a problem and a remedy.
 *
 * ⚠️ EVERY PATH RETURNS A FAILURE. There is deliberately no branch that maps an
 * error to "carry on" — `verify:e2e` must fail when it cannot run, never skip
 * (AGENTS.md §7). An unrecognised error is reported verbatim rather than
 * swallowed, because a preflight that stays silent about a cause it does not
 * recognise is the same defect in a new place.
 */
export function describeDatabaseFailure(error, target) {
  const code = error?.code ?? error?.cause?.code;
  const known = KNOWN_CAUSES[code];
  if (known) return known(target);

  const detail = error?.message ?? String(error);
  return {
    problem: `could not use the database on ${target.hostPort} (${code ?? 'no error code'})`,
    remedy: `The driver reported: ${detail}`,
  };
}

/** The failure for a role that connects but cannot create the `drizzle` schema. */
export function describeMissingCreatePrivilege(target) {
  return {
    problem: `"${target.user}" can connect to "${target.database}" but cannot CREATE in it`,
    remedy:
      'Migrations run as the OWNER and start with `CREATE SCHEMA drizzle`. This ' +
      'looks like the restricted application role (see ' +
      'infrastructure/create-app-role.sql), which is deliberately NOSUPERUSER ' +
      'and holds no CREATE. Point E2E_DATABASE_URL at the owner connection.',
  };
}

/** `host:port`, `user` and `database` pulled off a parsed URL, for messages. */
export function connectionTarget(parsedUrl) {
  return {
    hostPort: `${parsedUrl.hostname}:${parsedUrl.port || 5432}`,
    user: decodeURIComponent(parsedUrl.username) || '(none)',
    database: decodeURIComponent(parsedUrl.pathname.replace(/^\//, '')) || '(none)',
  };
}
