# ADR-0057 — Three Growth palettes, and `growth-bright` becomes the default

**Status:** Accepted
**Scope:** Supersedes [ADR-0056](ADR-0056-user-theme-preference.md) **Decision 1's
default value only.** Its Decisions 2 (no `auto`), 3 (server-side resolution) and
4 (the 3D scene) are unchanged and remain in force.
**Date:** 2026-08-20

## Context

[ADR-0056](ADR-0056-user-theme-preference.md) added a per-account theme
preference with two palettes — Dark and Light — both quiet, neutral and
professional. Dark was the default.

Product feedback after reviewing visual directions: the product should have a
genuinely energetic default. The headline language already leans this way
("Start growing"); a graphite instrument panel fights it. Dark and Light stay
for people who want the quiet version.

## ⚠️ Re-measured first

Everything ADR-0056 describes still holds, verified rather than assumed: the
enum, the `NOT NULL DEFAULT` column, the server-side resolution in the root
layout, and the settings page. The dev database holds three real accounts — two
`dark`, one `light` — so the feature is in use, not merely shipped.

## Decision 1 — three palettes, distinguished by hue rather than by tint

`growth-bright`, `growth-dark`, `growth-warm`, in `tokens.css` beside the two
existing blocks, which are untouched.

**The hue is the whole distinction.** Dark and Light use hue **165** — a cool
teal-mint that reads as _instrument_, _telemetry_, _measured_. The Growth
palettes use **~133–140**, a leaf green that reads as _growth_ and _season_.
Thirty degrees apart is a different idea, not a lighter version of the same one.

The hue family was derived by converting the reviewed sketch
(`#639922` → `oklch(0.622 0.156 131.5)`) to anchor it honestly, then designing
around that anchor in OKLCH. No sketch value was copied.

| Theme           | Base                        | Accent                                      | Register                           |
| --------------- | --------------------------- | ------------------------------------------- | ---------------------------------- |
| `growth-bright` | Light, faint green cast     | Deep confident green                        | Decisive, optimistic. The default. |
| `growth-dark`   | Dark, green cast at hue 140 | Brighter and more saturated than plain Dark | The same energy after dark         |
| `growth-warm`   | Light, cream                | Amber                                       | Human rather than technical        |

`growth-dark` is deliberately **not** an inversion of `growth-bright`: its accent
is _brighter_ and more saturated (L 0.83, chroma 0.19) than the plain Dark
theme's (0.8 / 0.15), which is what makes it read as glowing rather than merely
visible. Its neutrals carry a green cast so the surface agrees with the accent
instead of sitting under it.

`growth-warm` exists because green says _"the chart is up"_ and amber says
_"someone is looking after this"_. For a plumber or a legal practice, a
dashboard that looks like a trading terminal is the wrong reassurance.

### ⚠️ Every accent is darker than its sketch, and the numbers decided that

The reviewed mid-green sits at L 0.622, which measures **3.2:1** on its own
surface — below the 4.5:1 body-text bar. It was dropped to L 0.52, where it
measures **5.23:1** and still reads as the same confident green.

This is exactly the trade ADR-0056's Light theme already made on its accent, and
for the same reason. An energetic palette that cannot be read is not a usable
palette. Every value was chosen by computing the ratio **first**, against a
calculator sanity-checked on the already-committed palettes.

`contrast.test.ts` holds all five themes to the identical bar — no exceptions for
the new ones being just launched.

⚠️ **A stricter bar was tried and withdrawn.** An early draft also required
`line-strong` to clear 3:1 against a surface. Neither existing theme meets that
(Dark 2.03, Light 1.75), and `accessibility.md` commits only to focus ring 3:1
and body text 4.5:1. Holding the new palettes to a standard the old ones fail is
not "the same bar", so the check was dropped.

## Decision 2 — `growth-bright` becomes the default, and this reverses ADR-0056

`DEFAULT_THEME_PREFERENCE` and the column default both move from `dark` to
`growth-bright`. Stated explicitly because it is a reversal, not an extension.

### ⚠️ It moves nobody, and that is deliberate

A column `DEFAULT` applies only to an `INSERT` that omits the column.
`theme_preference` is `NOT NULL` (migration 0012), so **every account that
exists is stored with an explicit value** — `dark` for anyone who never opened
the settings page.

Verified on a throwaway database rather than argued from SQL semantics: a row
written before the default changed still read `dark` afterwards; a row written
after read `growth-bright`. An integration test now performs the same `ALTER`
and asserts both halves.

**The consequence, stated rather than left to be discovered:** existing users on
the old default do **not** receive the new one. Nothing in the schema
distinguishes _"chose dark"_ from _"never chose"_, so a backfill would silently
re-theme people who had actually picked dark. Leaving them is the only option
that cannot be wrong about intent.

If the product later wants existing users moved, that needs a way to tell the
two apart — a nullable "chosen at" timestamp, or an explicit opt-in prompt — and
it is a separate decision, not a migration.

## Decision 3 — the type is recreated rather than extended

Migration 0013 drops and rebuilds `theme_preference` instead of using
`ALTER TYPE … ADD VALUE`.

**This is forced, not stylistic.** PostgreSQL refuses to _use_ an enum value in
the transaction that added it:

```
ERROR:  unsafe use of new value "growth-bright" of enum type theme_preference
HINT:   New enum values must be committed before they can be used.
```

Migrations 0009, 0010 and 0011 all used `ADD VALUE` safely because nothing
consumed the new value in the same run. This is the first migration that must
immediately `SET DEFAULT` to one.

⚠️ **Splitting it across two migration files does not help, which was measured.**
Drizzle applies every pending migration inside **one** transaction — a second
file rolled the first one back with it. On a fresh database, §7.2's from-zero
run puts all fourteen migrations in a single transaction, so no amount of
file-splitting could ever work.

Recreating the type is transaction-safe because `CREATE TYPE`, unlike
`ADD VALUE`, is usable immediately. Existing rows carry across through a
`::text` cast.

⚠️ **The enum's order is not the UI's order.** The rebuilt type lists
`dark, light, growth-bright, growth-dark, growth-warm`, preserving the original
two first; `THEME_PREFERENCES` lists the default first, for the settings page.
Nothing sorts on either, and a test asserts they agree as **sets**.

## What is unchanged

- **ADR-0056 Decision 2** — no `auto`. `prefers-color-scheme` remains dead code.
- **ADR-0056 Decision 3** — server-side resolution, no flash, no inline script.
  Five themes resolve exactly as two did.
- **ADR-0056 Decision 4** — the WebGL lattice reads four CSS custom properties at
  runtime and follows any theme with no code of its own. Re-verified against all
  three new palettes rather than assumed.
- Layout, typography, spacing, radius and every motion token. This is a palette,
  not a redesign.

## Consequences

- New accounts open on a palette that matches the product's language.
- Nobody is re-themed without asking.
- Five palettes must now be kept passing the contrast gate; the gate's parser
  was rewritten in the same change because it could no longer have failed
  (see the dev log).
- `growth-warm` introduces the first case where the accent and `attention` are
  drawn from the same colour family, so a new test requires them to differ by
  more than 20° of hue.
