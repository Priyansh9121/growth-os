# 0045 — A preflight that knocked instead of logging in

**Date:** 2026-08-21 · **Stage:** 4

## Objective

Make `verify:e2e`'s database preflight prove it can actually use the project's
database, not merely that something is listening on the port. The last item on
[0043](0043-the-browser-gate.md) and [0044](0044-two-flakes.md)'s remaining-work
lists.

## Initial state

Verified, not recalled: `b18937b`, tree clean, `0 0` against origin, remote
PRIVATE. `verify:all` exit 0 at **1372 passed / 321 skipped (1693)**, 29
boundary probes.

All three PostgreSQL ports on this machine were listening — `5432`, `55432`,
`55433` — which made the wrong-cluster case reproducible for free rather than
simulated.

## Confirmed by reading, not by trusting the previous log

§1 says re-verify rather than inherit a description. The check was:

```js
socket.once('connect', () => done(true));
```

A bare `net.Socket` handshake. **Any listener satisfies it** — a different
PostgreSQL, a different database entirely, or anything else bound to that port.

## ⚠️ Two corrections to the brief, both measured

**The failure did not surface "90 seconds later". It surfaced in 11.**
`globalSetup` runs before the web server is built, so the build cost is never
paid first. The new preflight fails in **0 s**, so the speed gain is real but
modest — and it is not where the value is.

**The value is that the old line was false.** Reproducing 0044 exactly:

```
▶ verify:e2e — database postgresql://growth_os:***@127.0.0.1:5432/growth_os_test reachable on 5432
...
Migration failed: DrizzleQueryError: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
  cause: PostgresError: password authentication failed for user "growth_os"
```

The real cause is in there — two levels down a `cause` chain, under a headline
about SQL, and after the preflight has already asserted the opposite. Saying
"reachable" about a database you cannot log in to is worse than saying nothing:
it moves the reader's suspicion away from the credentials, which is where the
answer was.

The brief asked me to say plainly if a stronger check could not do meaningfully
better than migrate's own error. **It can**, on two counts: it stops making a
false claim, and it leads with the cause instead of burying it. The 11 s → 0 s
saving is the smallest of the three benefits, and the one the earlier logs
oversold.

## What it checks now, and why that set

`globalSetup` runs `db:migrate`, and migrate's **first statement** is
`CREATE SCHEMA IF NOT EXISTS "drizzle"`. So the question is not "does a socket
accept" but "can this role create a schema in this database":

1. **A real authenticated connection** — catches wrong credentials, a missing
   database, a non-PostgreSQL service, and nothing listening.
2. **`has_database_privilege(current_user, current_database(), 'CREATE')`** —
   catches a role that connects perfectly and cannot do what migrate does next.

(2) is the reuse the brief asked for. It is the distinction
`infrastructure/create-app-role.sql` is built around: migrations run as the
**owner** precisely because the application role is `NOSUPERUSER NOCREATEDB` and
holds no CREATE.

⚠️ **It deliberately does not require the `drizzle` schema to exist.** A fresh,
empty database is the normal case — `globalSetup` migrates and seeds it.
Asserting on `__drizzle_migrations` would reject exactly the state the suite is
designed to start from.

## Proven against five real conditions

The two unrelated clusters on this machine made four of these genuine rather
than simulated. **The old TCP check passed the first four.**

| Condition                         | New verdict                                               |
| --------------------------------- | --------------------------------------------------------- |
| Wrong cluster, port 5432          | `authentication failed for user "growth_os"`              |
| Wrong cluster, port 55433         | `the server rejected the role "gos_admin"`                |
| Database absent, right server     | `database "no_such_database" does not exist`              |
| Nothing listening (59999)         | `nothing is listening on 127.0.0.1:59999`                 |
| **Restricted role, right server** | `can connect to "growth_os_test" but cannot CREATE in it` |

The last is the one worth dwelling on. `growth_os_app_test` authenticates
perfectly, passes any connectivity check you care to write, and would still have
died on the first migration. Only asking about the privilege catches it.

Each verdict names the host, port, role or database involved and a remedy that
points at the actual distinction — for the restricted role, at
`create-app-role.sql` and the owner/app split, not just "permission denied".

## The happy path is unchanged

```
▶ verify:e2e — connected to "growth_os_test" as "gos_admin" (127.0.0.1:55432), CREATE granted
  71 passed (1.0m)
```

Exit 0 in 63 s. The banner now states only what was proven.

## Tests, and what they actually guard

The classification lives in `scripts/database-preflight.mjs` as pure functions,
with **16 tests**, and vitest's unit project now includes `scripts/**/*.test.mjs`
so they run in `verify:all` — where no database exists.

That is deliberate. The defect these guard against is **silence**: one
"we do not recognise this error, carry on" branch and the browser gate goes
green having run no browser, which is the §7 promise `verify:e2e` exists to
keep. So one test asserts an unrecognised error still produces a failure, and
another asserts the code is read from `error.cause.code` — where postgres.js
actually puts the SQLSTATE, and missing it would classify every real failure as
unknown.

`postgres` is now a declared root devDependency rather than relied on via
hoisting from `packages/database`, matching how `esbuild` is declared for the
other root script, with `package-lock.json` synced so `npm ci` stays honest.

## Testing

- `verify:all` exit 0: **1388 passed / 321 skipped (1709)**, against 1372 / 321
  (1693) at `b18937b`. 29 boundary probes.
- `verify:e2e` exit 0: **71 passed**, 63 s.
- Five failure conditions reproduced live, each exiting 1 at the preflight.

## What is unverified

**I did not test a non-PostgreSQL service on the port.** All five conditions
involved a real PostgreSQL or nothing at all. A plain HTTP server on 5432 would
fall into the unrecognised-error branch, which is tested in the unit suite but
not against a live socket.

**The privilege check proves migrate's first statement can run, not that all
fourteen migrations will.** That is deliberate — the preflight is not a dry run
— but it means a database with CREATE and some other obstruction would still
fail later, correctly, inside migrate.

## Result

The last item from 0043 and 0044's lists is closed. The gate no longer makes a
claim it has not established.

## Remaining work

1. **Decide the signed-out palette** — track the default, or pin it (0040).
2. **`growth-warm`'s accent/attention separation** — amber-on-amber at 27° (0041).
3. **`--color-viz-*` per theme**, before Stage 5 ships charts. Still latent.

⚠️ **Migrations, measured not carried:** disk **14**, test DB **14**.
