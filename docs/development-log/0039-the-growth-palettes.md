# 0039 — Three Growth palettes, and two ways `ADD VALUE` could not do the job

**Date:** 2026-08-20 · **Stage:** 4

## Objective

Three new palettes beside Dark and Light, one of them the new default, offered
in the Appearance settings.

## Initial state

Verified, not recalled: `c791ffd`, tree clean, `0 0` against origin, remote
PRIVATE, PostgreSQL accepting on 55432. `verify:all` exit 0 at **1259 passed /
313 skipped (1572)**, 29 boundary probes.

Everything ADR-0056 describes was re-checked before extending it — the enum, the
`NOT NULL DEFAULT` column, server-side resolution, the settings page. All still
true. The dev database holds three real accounts, two `dark` and one `light`, so
the feature is in use rather than merely shipped.

## Designing against the gate instead of checking afterwards

The palettes were not picked and then tested. A small OKLCH → sRGB → WCAG
calculator was written first and **sanity-checked against the already-committed
palettes** — it reproduces Light's signal-on-white at 5.11:1, which is the
figure ADR-0056 says forced that accent darker. Only then were values chosen.

The reviewed sketch was converted rather than copied: `#639922` →
`oklch(0.622 0.156 131.5)`, which anchored the hue family at ~133. That is 30°
from the existing accent's 165 — Dark and Light read as _instrument_, the Growth
palettes as _season_.

⚠️ **The sketch's mid-green measures 3.2:1 on its own surface**, below the
body-text bar. Dropped to L 0.52 it measures 5.23:1 and still reads as the same
confident green. Exactly the trade Light already made.

All 57 new tokens were also checked against the sRGB gamut using a binary search
for the chroma ceiling at each lightness and hue, and four were nudged inward.

## ⚠️ Three findings, each of which changed the plan

### 1. The contrast gate could no longer have failed

`contrast.test.ts` parsed the light theme with `css.slice(blockStart)` and
first-definition-wins. That works only while light is the **last** block in the
file. With three blocks after it, every theme would appear to define every token
— so _"defines every semantic colour"_ could never fail again, silently, exactly
when five themes made it matter most.

Blocks are now extracted to their closing brace, and integrity is checked
against what a block defines **itself** rather than the merged view: a theme
inheriting a colour from the dark base would pass a merged check while rendering
a dark value on a light surface.

Proven rather than asserted — deleting `--color-text-subtle` from `growth-warm`
fails with _"growth-warm does not define --color-text-subtle"_; restoring it
returns 58 passed.

### 2. `ALTER TYPE ... ADD VALUE` cannot do what the brief asked, twice over

The brief specified one migration adding three enum values **and** changing the
column default. Measured:

```
ERROR:  unsafe use of new value "growth-bright" of enum type theme_preference
HINT:   New enum values must be committed before they can be used.
```

Migrations 0009, 0010 and 0011 all used `ADD VALUE` safely because nothing
consumed the new value in the same run. This is the first that must immediately
`SET DEFAULT` to one.

⚠️ **The obvious fix — two migration files — does not work either, and that is
the part I did not expect.** I wrote 0013 and 0014, ran them, and 0013 rolled
back with 0014: **drizzle applies every pending migration inside one
transaction.** On a fresh database, §7.2's from-zero run puts all fourteen in a
single transaction, so no amount of file-splitting could ever have worked. 0014
was deleted.

0013 therefore recreates the type — drop the default, `CREATE TYPE` with all
five, `ALTER COLUMN … USING ::text`, drop the old, rename, set the new default.
`CREATE TYPE` is usable immediately where `ADD VALUE` is not.

### 3. The settings tests had an ambiguity the component did not

The component needed **no change** — it renders from `THEME_PREFERENCES`, so it
showed five options as soon as the vocabulary grew. Its tests did:
`getByRole('radio', { name: /dark/i })` matches both "Dark" and "Growth Dark",
and anchoring to `^Growth\b` matches all three Growth themes.

They now select by the input's `value`, which is exact by construction, and
assert the accessible name as its own property rather than relying on it to find
elements. That is the same ambiguity a **user** faces, which is why the labels
and descriptions are now asserted for every theme rather than a sample.

## Existing accounts: confirmed unaffected

The brief asked for this to be confirmed rather than assumed, and to stop if it
turned out otherwise. It did not.

A column `DEFAULT` applies only to an `INSERT` that omits the column, and
`theme_preference` is `NOT NULL`, so every account is stored explicitly. Proven
on a throwaway database first — a row written before the default changed still
read `dark`; one written after read `growth-bright` — and then pinned as an
integration test that performs the same `ALTER` and asserts both halves.

**The consequence is stated rather than buried:** people on the old default do
**not** receive the new one. Nothing distinguishes _"chose dark"_ from _"never
chose"_, so a backfill would silently re-theme people who had actually picked
dark. ADR-0057 records leaving them as the deliberate choice.

## Tests updated, not weakened

Three tests asserted the old default as a literal and would now be wrong. They
assert `growth-bright` **and** the constant — checking only
`DEFAULT_THEME_PREFERENCE` would still pass if the column default and the
application had drifted apart, which is the one failure they exist to catch.

A new test refuses near-miss typos — `growth`, `growth-light`, `Growth-Bright`,
`growthbright` — which only became plausible now that three values share a
prefix.

⚠️ **A stricter bar was tried and withdrawn.** An early draft held the new
palettes to 3:1 on `line-strong`. Neither existing theme meets it (Dark 2.03,
Light 1.75) and `accessibility.md` commits only to focus ring 3:1 and body text
4.5:1. Holding new palettes to a standard the old ones fail is not "the same
bar", so the check was dropped — a negative result worth recording.

## What was built

| Slice     | Change                                                         |
| --------- | -------------------------------------------------------------- |
| `5aee129` | Three palettes in `tokens.css`; contrast suite 18 → 58         |
| `80b0390` | Five-value vocabulary, migration 0013, ADR-0057, updated tests |
| _this_    | 3D re-verification, design-system.md, this log                 |

## Testing

- `verify:all` exit 0: **1304 passed / 321 skipped (1625)**, against 1259 / 313
  (1572) at `c791ffd`. 29 boundary probes.
- §7.2: 14 migrations applied from zero on a throwaway database — the run where
  the single-transaction constraint actually bites — producing the full
  five-value enum and the `growth-bright` default on a fresh schema. Full suite
  **1628 passed (1628)**, exit 0, database destroyed.

The 3D claim was re-verified rather than inherited, as the brief asked: each
Growth palette's real canvas and signal values are pushed through `readPalette`
and asserted to come back unmodified, and explicitly **not** to equal the
dark-theme fallback that a hard-coded scene would return.

## Result

Five themes. `growth-bright` is the default for new accounts; nobody existing
was moved. All five clear the same contrast bar, enforced rather than asserted.

## ⚠️ What is unverified

**Nothing rendered these palettes.** `next build` was not run and no browser
opened this product. Contrast, gamut and token integrity are computed from the
values; whether `growth-warm`'s amber actually _feels_ warm, or whether
`growth-dark` reads as glowing rather than murky, is unmeasured and unseen. The
claim I stand behind is "the numbers are right", not "it looks right" — and for
a change whose entire purpose is how the product feels, that is a real gap.

**The `viz-*` series is not overridden by any theme**, including the two that
predate this work. Light-based palettes inherit data-visualisation colours
designed against a dark canvas. Pre-existing, out of scope here, and worth its
own brief before charts ship.

## Remaining work

1. **Look at them.** `next build` plus a pass through all five, ideally a
   Playwright spec — the e2e suite exists but is not in `verify:all`. This is
   the first item for a reason.
2. **`viz-*` per theme**, before Stage 5 puts charts on a light surface.
3. **`auto`**, still one enum value and one radio button away — though it now
   needs a decision about which of five it follows.
4. **Inject the database into `runOnce`** — carried from 0037, still first for
   the worker.

⚠️ **Carried and re-measured — and my draft of this line was wrong for the third
session running.** I wrote "12 of 14" from arithmetic. Measured: the local dev
database is at **13 of 14**, the test database at 14 of 14, with this session's
0013 applied to the test database only.

Three sessions have now caught this exact line stale in draft (0037 wrote "8 of
10", 0038 wrote "12 of 13", this one "12 of 14"). The pattern is the point: a
carried number is not knowledge, and `select count(*) from
drizzle.__drizzle_migrations` costs nothing.
