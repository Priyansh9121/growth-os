# ADR-0058 — The dashboard spends more accent, and only the Growth themes do

**Status:** Accepted
**Scope:** Narrows the "≲5% of a screen" accent discipline for **dashboard stat
cards only**. The general guidance in `design-system.md` §1 and
`brand-direction.md` §2 is unchanged everywhere else.
**Date:** 2026-08-20

## Context

[Dev log 0040](../development-log/0040-opening-a-browser.md) opened a browser on
all five themes and found the Growth palettes correctly implemented but not
delivering their intent on the dashboard:

> growth-bright … reads calm, clean and competent — good work, but closer to
> well-made SaaS than to a hero arriving. The reason is structural rather than a
> fault in the palette: the design system caps the accent at _"≲5% of a screen"_,
> and on a data-dense dashboard that leaves the green in a nav pill, a logo and
> four tiny percentages. Every large number is near-black.

The same palette **does** land on the login page, where a large CTA and the
lattice carry it. The palette has the range; the dashboard was not spending it.

## ⚠️ Re-measured first, and two of the three proposed changes already existed

The brief proposed three changes ("Direction C"). Measurement found most of it
already shipped:

| Element                          | State before this ADR                                   |
| -------------------------------- | ------------------------------------------------------- |
| Positive deltas in accent colour | **Already done** — `DELTA_CLASSES.good = 'text-signal'` |
| Solid-accent primary CTA         | **Already done** — `Button` primary is `bg-signal`      |
| Left accent stripe on cards      | Missing                                                 |
| Large metric values in accent    | Missing — all `text-text`                               |

The `~5%` rule is **convention only**: stated in three files
(`design-system.md:55`, `brand-direction.md:55`, `tokens.css:105`) and enforced
by no lint rule and no test. Notably, `design-system.md`'s own accent table
already lists the sanctioned uses as _"Primary actions, active nav, **positive
delta**, AI presence"_ — so two of the three were never exceptions at all.

## Decision 1 — emphasis is a token, not a theme check

Two tokens, declared in `@theme` and overridden only by the three Growth blocks:

```css
--color-metric-emphasis: var(--color-text); /* base: no emphasis */
--color-card-accent: transparent;
```

Both resolve **lazily**. `var(--color-text)` is not evaluated where it is
declared — it is evaluated where the token is _used_, against whatever
`--color-text` the active theme set. Dark and Light therefore get their own
correct text colour with no per-theme declaration.

⚠️ **That laziness is the safety property, not a convenience.** Had the base
hard-coded the dark theme's text colour, Light would have rendered its metric
values near-white on white. A sixth theme added later inherits "off"
automatically rather than inheriting a value from the dark base.

**No component contains a `theme === '…'` branch.** One class name
(`border-l-card-accent`) is a visible stripe under Growth and nothing at all
under Dark and Light. This is what makes the whole rule assertable in
`contrast.test.ts` rather than spread across components.

## Decision 2 — Dark and Light are excluded, deliberately

[ADR-0057](ADR-0057-growth-theme-palettes.md) keeps Dark and Light as the quiet
option: _"Dark and Light stay for people who want the quiet version."_ Applying
this treatment to all five would have contradicted that — nine stat cards would
each gain an accent stripe and three large numbers would turn mint-green in a
palette whose entire purpose is restraint.

This was raised as a blocking question rather than decided unilaterally, and the
answer was to scope it to the Growth themes. A test asserts Light does not
declare the emphasis tokens and that the base resolves them to ordinary text —
so the split is enforced, not just documented.

## Decision 3 — a value earns the accent only for a good measured movement

`valueEarnsAccent` requires a delta **and** `deltaTone(...) === 'good'`.

⚠️ **Polarity, not sign.** `deltaTone` already combined direction with
`TrendPolarity`, because "missed calls rising is bad, revenue rising is good".
Reading the sign off a number would emphasise a rise in missed calls.

⚠️ **A metric with no delta is not emphasised.** Five of the dashboard's live
CRM metrics — New contacts, Qualified leads, Open opportunities, Pipeline value,
Open tasks — carry no delta at all. They have no direction and therefore no
judgement to render. Colouring them would mark a number for merely existing,
which is precisely the failure the ~5% rule names: _if everything is
highlighted, nothing is._

On the current dashboard this emphasises **3 of 10** values (Growth score,
Tracked calls, Attributed revenue) and leaves Missed calls in `attention` amber.

The stripe, by contrast, is on **every** card. It is structure — "this is a stat
card" — not a judgement, and `border-l-2` is applied unconditionally so the box
model is identical in all five themes. A stripe that changed the layout would
move content when someone switched theme.

## ⚠️ Decision 4 — the primary CTA's label colour, which had never applied

Verifying the CTA's contrast, as this work required, found that it was not the
combination anyone thought.

`Button`'s primary variant is `bg-signal text-text-inverse`, and its own comment
justifies the inverse on contrast grounds. **`cn` was deleting the colour.**

`tailwind-merge` classifies `text-*` into a font-size group or a text-colour
group using its knowledge of Tailwind's **default** scale. This project's scale
is bespoke (`text-body`, `text-metric-lg`, `text-overline`), so it recognised
none of them and treated every `text-*` as one group. `Button` composes
`VARIANT_CLASSES` then `SIZE_CLASSES`; last-one-wins dropped `text-text-inverse`
from every button in the product.

Measured in the browser — the class was absent from the rendered `class`
attribute, and the label rendered in `--color-text` on the accent fill:

| Theme         | Actual (shipped) | Intended (`text-inverse`) |
| ------------- | ---------------: | ------------------------: |
| dark          |       **1.61:1** |                   11.06:1 |
| light         |       **3.39:1** |                    4.96:1 |
| growth-bright |       **2.83:1** |                    5.10:1 |
| growth-dark   |       **1.47:1** |                   12.12:1 |
| growth-warm   |       **2.57:1** |                    5.60:1 |

Every theme failed 4.5:1, including the "Sign in" button on the login page. The
comment described a protection that had never once been in force.

Fixed by teaching `tailwind-merge` this project's font-size scale, so a size and
a colour stop being the same conflict. This is a **product-wide** change to
`packages/ui/src/lib/cn.ts` rather than a dashboard one — a scope expansion,
reported as such, and unavoidable: the brief required inverse-on-accent to be
tested _and to pass_, and there was no way to make it pass while the class was
being stripped.

A test asserts `FONT_SIZE_STEPS` matches every `--text-*` step in `tokens.css`,
so adding a type step cannot silently reintroduce the collision.

## Consequences

- The dashboard reads as the palette intended under the three Growth themes.
- Dark and Light are unchanged, provably.
- Every primary button in the product has a readable label for the first time.
- The general ~5% guidance stands; this is a named, bounded exception, and a
  test pins the selectivity that keeps it meaningful.
- New contrast pairs are gated at the same 4.5:1 as everything else, plus a
  negative assertion that ordinary text on the accent would _not_ be readable —
  so if that ever stops being true, the inverse is re-examined rather than
  quietly kept.
