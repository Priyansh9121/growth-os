# ADR-0056 — A per-account theme preference, and the light palette that already existed

**Status:** Accepted · Decision 1's default superseded by
[ADR-0057](ADR-0057-growth-theme-palettes.md)
**Date:** 2026-08-20

> ⚠️ **Scope of the supersession, 2026-08-20.** ADR-0057 changes **only** the
> default value in Decision 1, from `dark` to `growth-bright`, and adds three
> palettes. The mechanism in Decision 1 (a `NOT NULL` enum column on `users`),
> and Decisions 2, 3 and 4 in full, are unchanged and remain in force. The body
> below is untouched and was correct when written; read it for the reasoning,
> and ADR-0057 for the current default.
>
> The status is qualified rather than a bare `Superseded by ADR-0057` because a
> bare marker would tell a reader that server-side resolution and the `auto`
> decision had also been reversed, which they have not.

## Context

The brief that commissioned this work described the product as "dark-only by
design" and asked for a light theme to be built.

## ⚠️ Re-measured first: most of it was already there

| Assumed missing        | Measured at `c89119a`                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| A light palette        | `tokens.css:186` — a full `:root[data-theme='light']` block since `f833f66` |
| Contrast verification  | `contrast.test.ts` — a `light theme contrast` suite, passing                |
| Documentation          | `design-system.md §1` — "a re-mapping, not an inversion"                    |
| OS preference handling | `tokens.css:219` — `@media (prefers-color-scheme: light)`                   |

What did **not** exist was any way to reach it. `layout.tsx:59` hardcoded
`data-theme="dark"`, which also made the `prefers-color-scheme` block dead code,
since it is written as `:root:not([data-theme='dark'])`. The layout's own
comment anticipated the gap: _"a future theme-preference script will set
data-theme before React hydrates."_

So this is a switch, not a design. **No palette was created, altered or
re-tuned.** The accessibility question the brief raised was already answered by
a build gate, not by a document.

## Decision 1 — the preference is a column on `users`, defaulting to `dark`

`users.theme_preference`, an enum, `NOT NULL DEFAULT 'dark'`.

**Server-side, because the requirement is "across devices".** `localStorage`
would make the setting a property of a browser, not of a person; signing in on a
second machine would silently show a different product.

**`NOT NULL DEFAULT 'dark'` is the entire compatibility story**, and it is one
statement rather than a backfill script: every account that existed before this
column keeps exactly the appearance it had, and no read path has to decide what
a null theme means.

**An enum rather than text**, because §5 puts limits in the database. The valid
set is a constraint: a typo in a future route is refused by PostgreSQL rather
than stored and rendered as an unstyled page. Drizzle builds the enum from
`THEME_PREFERENCES` in `@growth-os/contracts`, so the column and the settings
form cannot drift — a disagreement would otherwise surface only in production,
as a refused write.

## Decision 2 — `auto` is deliberately absent

`tokens.css` already follows `prefers-color-scheme` whenever `data-theme` is
absent, so an OS-following option is one enum value away.

It is not shipped because this change is explicit-choice-only, and a value the
settings page cannot produce is a state nothing can clear. Adding it later is
`ALTER TYPE … ADD VALUE` plus a radio button — the precedent is migrations 0009,
0010 and 0011.

⚠️ **A consequence worth naming:** because the layout will always emit an
explicit `data-theme`, the `prefers-color-scheme` block in `tokens.css` stays
dead code. It is left in place rather than deleted — the brief is additive, and
it becomes live the moment `auto` is added.

## Decision 3 — applied before first paint, from the server

The theme is resolved **on the server**, from the session, and written into the
`<html>` element that Next.js streams. There is no client script, no
`localStorage` read, and no post-hydration correction.

### ⚠️ Why not the usual inline blocking script

The common pattern — an inline `<script>` in `<head>` that reads
`localStorage` and sets `data-theme` before paint — exists to solve a problem
this product does not have: a preference that only the browser knows. Here the
preference arrives with the session the server already resolves to render the
page at all.

Reading it server-side means the correct attribute is in the first byte of HTML.
There is no window in which the wrong theme is painted, so there is nothing to
suppress, and no third copy of the theme vocabulary living in a stringified
script.

For a signed-out visitor there is no preference to apply, and the answer is the
default: `dark`, exactly as today.

## Decision 4 — the 3D scene and the motion system are unaffected, and this is by prior design

`readPalette()` in `lattice-geometry.ts` reads `--color-signal`,
`--color-signal-dim`, `--color-attention` and `--color-canvas` from
`getComputedStyle(document.documentElement)` at runtime. The light theme
redefines all four. **The lattice therefore follows the theme with no change**,
which its own docblock already promised: _"the lattice follows a theme change or
a palette revision automatically."_

Nothing in the motion system is colour-dependent: durations and easings are
theme-independent tokens, and the reduced-motion backstop is unchanged.

⚠️ **The one real caveat, stated rather than discovered later:** the scene reads
the palette **once**, in a `useMemo` with an empty dependency list. A theme
change while the scene is mounted would not repaint it. That cannot happen
today — `GrowthFieldHost` renders nothing once the transition machine reaches
`complete`, so the scene exists only before authentication, and the setting
exists only after it. If the scene is ever shown on an authenticated surface,
that memo becomes a bug.

## Consequences

- A person's theme follows their account across devices.
- Every existing account is untouched, guaranteed by the column default rather
  than by application code.
- The light palette becomes reachable for the first time; its contrast was
  already gated.
- `prefers-color-scheme` remains dead until `auto` is added.

## Alternatives considered

**`localStorage` only.** Rejected: fails the across-devices requirement, and
would need the blocking-script pattern that Decision 3 avoids.

**A `user_preferences` table.** Rejected as premature. One column on `users` is
the honest shape for one preference; a table earns its place when there are
several and they are written independently.

**Redesigning the light palette into an "energetic growth" theme.** Considered
and explicitly declined by the person commissioning the work: it would alter a
committed design decision and its documentation, where this pass is additive.
