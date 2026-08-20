# 0038 — The theme switch, and the light theme that had been there all along

**Date:** 2026-08-20 · **Stage:** 4

## Objective

Add a light theme alongside the dark one, with a per-user setting stored
server-side, defaulting to dark.

## Initial state

Verified, not recalled: `c89119a`, tree clean, `0 0` against origin, remote
PRIVATE. Tests **1250 passed / 299 skipped (1549)**, 29 boundary probes.

### ⚠️ But `verify:all` exited 1 on a clean tree

`verify:gitignore` failed on `apps/web/.env.local` — untracked, correctly
ignored, and reported as _"first-party path is IGNORED"_. That is the gate
misreading a deliberately hidden secret as lost source.

Reported before doing anything, because §4 forbids committing onto a red tree
and the file is a local config that is not mine to delete.

## ⚠️ The brief's premise was wrong

It described the product as "dark-only by design" and asked for a light theme,
contrast verification and documentation. Measured at `c89119a`:

| Assumed missing        | Reality                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| A light palette        | `tokens.css:186` — a full `:root[data-theme='light']` block since `f833f66` |
| Contrast verification  | `contrast.test.ts` — a passing `light theme contrast` suite                 |
| Documentation          | `design-system.md §1` — "a re-mapping, not an inversion"                    |
| OS preference handling | `tokens.css:219` — `@media (prefers-color-scheme: light)`                   |

What did **not** exist was any way to reach it. `layout.tsx:59` hardcoded
`data-theme="dark"`, which also made the media block dead, since it is written
as `:root:not([data-theme='dark'])`. The layout's own comment named the gap:
_"a future theme-preference script will set data-theme before React hydrates."_

So the work was the switch, not a design. **No palette was created, altered or
re-tuned**, and the accessibility bar the brief asked about was already a build
gate rather than a claim in a document.

Both the premise and the blocker went back to the person commissioning the work
rather than being guessed at. They chose: wire up the existing light theme, and
exempt `.env*` in the verifier.

## ⚠️ The exemption was unsafe as first written

The exemption was justified on the grounds that property 3 of the verifier still
fails the build if a `.env` file is ever **tracked**. That justification was
wrong, and measuring it rather than asserting it is what found the real bug.

Property 3 tested `path.startsWith('.env')`, which only ever matched at the
repository **root**:

```
CAUGHT  .env.local
MISSED  apps/web/.env.local
MISSED  packages/ui/.env
MISSED  apps/web/.env.production
```

Property 1 had been incidentally covering nested env files, badly and with a
misleading message. Property 3 never covered them at all. Exempting them from
property 1 alone would have left a **tracked** nested env file passing the whole
gate — in a monorepo, which is precisely where env files are nested.

Property 3 now matches on the basename. Verified end to end by staging a nested
`.env.probe` with `git add -f` and watching the gate fail, then unstaging it.

## What was built

| Slice     | Change                                                                  |
| --------- | ----------------------------------------------------------------------- |
| `64400f8` | The verifier fix and its rationale doc                                  |
| `d082a56` | `THEME_PREFERENCES`, migration 0012, `users.theme_preference`, ADR-0056 |
| `e5f29e5` | `getThemePreference` / `setThemePreference`                             |
| `f5b1d81` | Server-resolved theme in the layout, the API route, the Appearance page |

### The column carries the compatibility guarantee

`NOT NULL DEFAULT 'dark'`, so the default backfills every existing row in one
statement. No account changes appearance until someone chooses, and no read path
has to decide what a null theme means. An enum rather than text, because §5 puts
limits in the database — §6's test is the row that must be refused, so the suite
tries `UPDATE users SET theme_preference = 'solarized'` in raw SQL and asserts
both that it rejects and that the value was not silently coerced.

### Server-resolved, so there is no flash and no inline script

The usual fix for theme flashing is a blocking `<script>` in `<head>` reading
`localStorage`. That exists to solve a problem this product does not have: a
preference only the browser knows. Here it lives on the account and the server
is already resolving the session to render the page, so the correct `data-theme`
is in the **first byte of HTML** — nothing to suppress, and no third copy of the
theme vocabulary inside a stringified script.

`resolveRequestTheme` validates the session but deliberately skips
`resolveActor`, whose membership and agency joins are real work and none of it
needed to choose a colour. It never throws: it runs in the ROOT layout, so an
exception would replace every page in the product — including the login page
someone needs to fix whatever broke — over a colour scheme.

**Measured before wiring:** every route was already `force-dynamic`, including
the public hosted forms, so reading the session in the root layout costs no
static rendering. There was none to lose.

### `Actor` was left alone

The obvious home for the preference was the `Actor` type, which the layout
already has. Rejected: `Actor` is an authorization value — its own docblock says
`workspaces` is "the complete set the actor may touch" — and a theme is
presentation. Widening a security-critical type with a cosmetic field is how the
next, non-cosmetic field gets added to it too. It would also have meant touching
22 `Actor` literals across 15 files, measured, for a colour scheme.

## Verifying against the installed Next.js

`apps/web/AGENTS.md` requires reading the installed docs rather than trusting
training data. Next 16.3.1:

- `cookies()` is async and must be awaited — `cookies.md:67`.
- An async layout calling it is the documented pattern — `layout.md:161`.
- `runtime = 'nodejs'` remains valid; only `'edge'` is deprecated.
- ⚠️ **`dynamic` is removed in v16 only when Cache Components is enabled.**
  `next.config.ts` does not enable it, so the root layout's `force-dynamic`
  really applies. Had it not, a per-user theme resolved in the root layout would
  have been a cross-user cache leak rather than a cosmetic bug.

## The 3D scene: unaffected, and now proven so

`readPalette` reads `--color-signal`, `--color-signal-dim`, `--color-attention`
and `--color-canvas` from `getComputedStyle` at runtime; the light theme
redefines all four. The lattice therefore follows the theme with no change,
which its own docblock already promised.

That was a claim about wiring, so it is now a test: absurd values injected
through those variables come back out, so a hard-coded hex added later fails the
build. Stated honestly — jsdom does not apply `tokens.css`, so it proves the
mechanism, not the specific light values.

⚠️ **One caveat recorded rather than left to be found:** the scene reads the
palette once, in a `useMemo` with an empty dependency list. A theme change while
it is mounted would not repaint it. That cannot happen today — the scene renders
nothing once the login transition completes, so it exists only before
authentication and the setting only after. If the lattice is ever shown on an
authenticated surface, that memo becomes a bug.

## Testing

- `verify:all` exit 0: **1259 passed / 313 skipped (1572)**, against 1250 / 299
  (1549) at `c89119a`. 29 boundary probes.
- §7.2: 13 migrations applied from zero on a throwaway database; the column
  arrives `NOT NULL DEFAULT 'dark'` and the enum is exactly `dark, light` on a
  fresh schema. Full suite **1572 passed (1572)**, exit 0, database destroyed.
- 14 of the 23 new tests need a database; 9 run in the default gate.

The failure path is tested in both directions: a bad status and a rejected
fetch both revert the attribute and announce an error. A theme that looks saved
and is not is worse than one that visibly refused, because the next device
disagrees and the user cannot tell which is lying.

## Result

A person chooses their theme at System → Appearance. It is stored on their
account, follows them across devices, and paints correctly on first byte. Every
existing account is unchanged, guaranteed by a column default rather than by
application code.

## ⚠️ What is unverified

**Nothing rendered the pages.** `next build` was not run and no browser opened
this product. The layout, page and route are covered by typecheck, lint and the
component tests only; the Appearance page itself has no test, and I have not
seen the light theme on screen. The claim I would stand behind is "it typechecks
and the units pass", not "it looks right".

**`prefers-color-scheme` is now provably dead code** — the layout always emits an
explicit `data-theme`. Kept deliberately, live again the moment `auto` exists.

## Remaining work

1. **`auto`.** One enum value, one radio, and the media block wakes up. The
   natural next increment and the reason the vocabulary is a list rather than a
   boolean.
2. **Render it.** `next build` plus a look at both themes, ideally a Playwright
   spec — the e2e suite exists but is not in `verify:all`.
3. **Extract the verifier's predicates to a tested module.** `scripts/` has no
   test harness at all, verified this session, so this session's gate fix is
   proven by a manual probe rather than by a regression test.
4. **Inject the database into `runOnce`** — carried from 0037, still first for
   the worker.

⚠️ **Carried and re-measured, and my own first draft of this line was wrong.**
It said "12 of 13" from arithmetic. Measured: the local dev database is at **11
of 13**, and the test database at 13 of 13 — 0037's `0011` and this session's
`0012` were both applied to the test database only. The sentence six earlier
logs copied, "8 of 10", has been wrong since 0037 rebuilt the cluster.

Two sessions running have now caught this line being stale in draft. It is
cheaper to run `select count(*) from drizzle.__drizzle_migrations` than to carry
it.
