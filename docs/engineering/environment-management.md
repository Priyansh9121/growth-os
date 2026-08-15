# Environment Management

**Status:** Implemented (Stage 1)
**Implementation:** [`packages/contracts/src/env.ts`](../../packages/contracts/src/env.ts)

## Fail fast, at boot

`process.env` is parsed **once** at process start against a Zod schema. Invalid
or missing required configuration **throws and refuses to boot**.

A typo in `DATABASE_URL` should be a startup failure naming the variable — not
a confusing error an hour later under load, in a code path nobody was looking
at.

## Error messages name keys, never values

An environment error routinely ends up in a log aggregator, a CI transcript or
a screenshot in a chat. Printing the offending _value_ would put a secret in
all three.

## Production-only guards

| Guard                                             | Prevents                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SESSION_SECRET` ≠ the `.env.example` placeholder | A deployment inheriting a **publicly known** secret from the repository                                            |
| `APP_URL` must be https                           | Session cookies are `Secure`-only; http in production means nobody can sign in                                     |
| `RATE_LIMIT_DRIVER=redis` rejected                | Failing loudly beats silently using the in-memory driver while an operator believes they have distributed limiting |

The middle guard fires during local production builds and is
[documented as expected](../operations/troubleshooting.md), not softened — the alternative is
a subtly broken production deployment.

## Files

| File             | Tracked? | Purpose                                |
| ---------------- | -------- | -------------------------------------- |
| `.env.example`   | **yes**  | Documented placeholders. The reference |
| `.env.local`     | no       | Your machine                           |
| `.env`, `.env.*` | no       | Blanket deny in `.gitignore`           |

`npm run verify:gitignore` asserts `.env` and `.env.local` **are** ignored and
`.env.example` is **not** — so the deny-then-allow rule cannot silently break.

## Server vs client

`env.ts` is exported under a **separate** entry point
(`@growth-os/contracts/env`) rather than from the package index. Importing the
package from a client component therefore cannot pull secrets into a browser
bundle. Only `NEXT_PUBLIC_*` values ever reach the browser, and none are used
today.

## Adding a variable

1. Add it to the schema in `env.ts`, with a sane default if optional.
2. Add it to `.env.example` with a **placeholder** and a comment explaining
   what it does and how to generate it.
3. If it is required in production, add a `.refine()` guard.
4. If it is a secret, confirm it is never logged and never crosses to the
   client.
5. Document the operational impact of rotating it.

## Rotation

`SESSION_SECRET` rotation invalidates every active session by design — it is
the documented emergency "sign everyone out" procedure. `DATABASE_URL`
rotation needs a rolling restart. Neither is automated yet; both are recorded
in [backup-recovery.md](../operations/backup-recovery.md).
