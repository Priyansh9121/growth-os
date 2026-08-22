# ADR-0061 — Two derived viz sequences, one per canvas class, and the standard they are derived against

**Status:** Accepted
**Scope:** `--color-viz-1` … `--color-viz-6` in all five themes, and the
assertions covering them in `contrast.test.ts`. No other token changes.
**Date:** 2026-08-22

## Context

`--color-viz-1` … `-6` were declared once, in the `@theme` block, and never
overridden. Dev log 0039 flagged that light palettes therefore inherit chart
colours tuned against a dark canvas; 0040 through 0047 each carried it forward
as _"still latent"_, on the grounds that nothing consumed the tokens yet.

Re-measured before any change: **6 tokens, one declaration site, zero
consumers.** `tokens.css` declares them, `design-system.md` documents them, and
no component, script or test reads them. All three prior claims still hold.

⚠️ **A fourth fact, which none of those logs record and which changes the
defect's description entirely — see "The tokens were not in the browser" below.**

## ⚠️ The defect is worse than "inherits dark colours" — there are two

**One: the whole sequence is below the contrast floor on three of five themes.**
WCAG 1.4.11 requires 3:1 for a graphical object carrying meaning. Measured
against each theme's own canvas:

| Theme           | viz-1 | viz-2 | viz-3 | viz-4 | viz-5 | viz-6 | below 3:1 |
| --------------- | ----: | ----: | ----: | ----: | ----: | ----: | --------: |
| `dark`          | 11.28 |  8.11 |  6.47 | 10.43 |  6.33 |  9.60 |     0 / 6 |
| `growth-dark`   | 11.11 |  7.99 |  6.37 | 10.27 |  6.24 |  9.46 |     0 / 6 |
| `light`         |  1.68 |  2.34 |  2.93 |  1.82 |  2.99 |  1.97 | **6 / 6** |
| `growth-bright` |  1.67 |  2.32 |  2.90 |  1.80 |  2.97 |  1.96 | **6 / 6** |
| `growth-warm`   |  1.67 |  2.32 |  2.90 |  1.80 |  2.97 |  1.96 | **6 / 6** |

Eighteen of thirty combinations fail. Not one light-theme colour passes.

**Two: the sequence never met its own documented claim, on any theme.** Both
`tokens.css` and `design-system.md` described it as _"chosen for
distinguishability under both common colour-vision deficiencies and greyscale
printing"_. Measured on the dark canvas, where it does render correctly:

| Pair         | red-green dichromacy | greyscale |
| ------------ | -------------------: | --------: |
| azure/violet |            **0.003** |     0.087 |
| rose/teal    |            **0.012** |     0.174 |
| violet/rose  |                0.149 | **0.007** |

Six series carried only **four distinct lightness values** — `viz-1`/`viz-4`
both at L 0.80 and `viz-3`/`viz-5` both at L 0.68 — so two pairs were identical
in greyscale by construction. The claim was a comment, asserted by nothing.

## ⚠️ The tokens were not in the browser at all

Every dev log from 0039 to 0047 describes the defect as _light palettes inherit
chart colours designed against a dark canvas_. Measured in a real browser
against a production build, that is not what happens.

**Tailwind v4 tree-shakes `@theme` variables that nothing references.** Built
from the pre-change tree, `--color-viz` appears **zero times** in the compiled
stylesheet. Reading `getComputedStyle(document.documentElement)` returns the
empty string for all six, in all five themes.

So a chart written today against `var(--color-viz-1)` would not have rendered a
wrong colour. It would have rendered **no colour**, in every theme including the
two the sequence was tuned for. "Latent" was more literally true than intended.

This has a direct consequence for the fix. The four explicit
`:root[data-theme=…]` blocks are ordinary CSS and are never tree-shaken, so
writing the sequences there is enough for four of the five themes. The dark base
has no such block — **the `@theme` block IS the dark theme** — so its sequence
must be declared `@theme static`, which opts out of tree-shaking. Verified by
rebuilding and re-reading the computed values: 60 occurrences in the compiled
CSS, and all six resolve in all five themes.

⚠️ **This was invisible to every static check, including the new ones.** The
tests in `contrast.test.ts` parse `tokens.css`; the compiler runs afterwards. A
test now asserts the `static` keyword specifically, because moving these six
declarations back into the ordinary `@theme` block would delete them from the
build while leaving the whole suite green — which is exactly the state this ADR
found them in.

## ⚠️ Five themes, but only two canvases

Contrast against the canvas is driven by lightness, and the five canvases hold
two values, not five:

| Theme           | canvas L | relative luminance |
| --------------- | -------: | -----------------: |
| `light`         |    0.985 |             0.9558 |
| `growth-warm`   |    0.982 |             0.9464 |
| `growth-bright` |    0.981 |             0.9466 |
| `growth-dark`   |    0.155 |             0.0039 |
| `dark`          |    0.145 |             0.0031 |

The light themes span **0.004** of lightness and the dark themes **0.010**.
Deriving five sequences would mean inventing differences no measurement
supports, which is the duplicated-vocabulary failure this repository rejects
elsewhere. So: **two derived sequences.** Each theme still declares its own
copy — see Decision 3.

## Decision 1 — six series, keeping the documented hue identities

The sequence stays six, and `viz-N` keeps the identity `design-system.md`
already names: green, azure, violet, amber, rose, teal. A chart legend must
mean the same thing in every theme.

Keeping the identities was checked rather than assumed. Anchoring each slot to
its documented hue (±20°) and optimising lightness and chroma reaches **better**
separation on light canvases than re-deriving hues freely (worst-pair ΔE 0.182
against 0.167), because the anchors already spread across the wheel. There was
no trade to make.

## Decision 2 — derived against four constraints, not chosen by eye

Every pair, in every theme, must satisfy all of:

| Constraint                        | Floor | light achieves | dark achieves |
| --------------------------------- | ----: | -------------: | ------------: |
| Contrast vs own canvas (WCAG)     |   3:1 |           3.07 |          3.47 |
| Separation, normal vision         |  0.12 |          0.127 |         0.200 |
| Separation, red-green dichromacy  |  0.10 |          0.113 |         0.165 |
| Separation, greyscale             |  0.04 |          0.045 |         0.068 |
| Distance from `--color-attention` |  0.09 |          0.122 |         0.150 |
| Distance from `--color-signal`    |  0.09 |      0.095 (¹) |     0.149 (¹) |

(¹) `viz-2`…`viz-6` only — see Decision 4.

⚠️ **The light sequence sits near a structural ceiling, and this is recorded
rather than engineered around.** Requiring 3:1 against a near-white canvas caps
how light a series may be, which caps the luminance range six series can
occupy. Measured ceiling for greyscale separation on a light canvas: **0.047**
with hues unconstrained, **0.045** with the documented identities kept. Five
series would reach 0.054. Six was chosen anyway — 0.045 is more than six times
today's 0.007, and `design-system.md` already requires labels, dash patterns or
markers, so greyscale is a safety net and not the sole carrier.

⚠️ **The optimum is degenerate without aesthetic bounds.** Unconstrained, the
search maximises separation by pushing series to the extremes of lightness and
minimum chroma: it proposed a near-black brown for "amber" and a near-white for
"violet". Chroma is therefore floored at 0.09 and lightness bounded per canvas
class, so each swatch still reads as the colour it is named after. Same lesson
as ADR-0060's dark-olive optimum.

## Decision 3 — each theme declares its own copy, none inherits

The two sequences are written into all five blocks rather than left to cascade.

This is not redundancy; it is what makes the guard possible. `contrast.test.ts`
already asserted that every theme _"defines every semantic colour ITSELF"_, with
the rationale that _"a theme that inherited a colour from the dark base would
pass a merged check while rendering a dark-theme value on a light surface —
which is precisely the bug this guards"_.

⚠️ **That is a description of this exact defect, written before it was found.**
The guard was correct and the viz tokens were simply missing from its list, so
nothing ever failed. They are in the list now.

## Decision 4 — only `viz-1` may sit in the accent family

`design-system.md` names `viz-1` "signal green" deliberately: a primary series
in the brand accent is intended, not a collision. `viz-2`…`viz-6` must stay
clear of `--color-signal`, and **all six** must stay clear of
`--color-attention` — a series that reads as the warning colour misreports the
data, which is the same class of defect ADR-0060 fixed for the accent itself.

Note the consequence in `growth-warm`, whose accent is amber rather than green:
`viz-1` keeps the green identity and so is _not_ that theme's accent family.
The identity is fixed across themes; the coincidence with the accent is not.

## Consequences

- Chart colours are correct on all five themes ahead of Stage 5, instead of on
  the two dark ones.
- Four properties that were previously claimed in prose are now asserted per
  theme, including the dichromacy simulation itself, which is validated against
  textbook pairs before anything uses it.
- The light sequence has a wider lightness spread than a conventional
  categorical palette. That is what greyscale separation costs on a light
  canvas, and it is deliberate.
- `growth-warm` keeps the weakest signal/attention pair (ADR-0060) and now also
  the tightest viz margins; both are the same structural cause — a light canvas
  with a warm accent.
- **Still zero consumers.** No chart renders these tokens, so nothing was
  screenshotted; a chart was not manufactured in order to have something to
  photograph. The browser check that _was_ possible — reading the computed
  values on a production build — is the one that found the tree-shaking, and it
  is the reason this ADR describes a different defect from the one the brief
  and five dev logs described.
