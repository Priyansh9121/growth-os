# 0048 — The chart colours were never there

**Date:** 2026-08-22 · **Stage:** 4

## Objective

Give every theme its own `--color-viz-*` sequence. Carried as _"still latent"_
on the remaining-work list of every dev log from
[0039](0039-the-growth-palettes.md) to [0047](0047-the-amber-that-was-two-ambers.md),
on the grounds that nothing consumes the tokens yet and Stage 5 will.

## Initial state

Verified, not recalled: `0407cc9`, tree clean, `## main...origin/main` with no
divergence. `npm test` exit 0 at **1406 passed / 321 skipped (1727)**.

All three PostgreSQL ports were listening — `5432`, `55432`, `55433`. The
project's cluster is the one on **55432** (`~/.growth-os/pgdata`, PID 11424),
identified by name rather than by "something answered" ([0045](0045-a-preflight-that-lied.md)).

The brief said not to inherit "6 tokens, zero consumers" from old logs. Both
re-measured and both still true: six declarations, all inside `@theme` at lines
136–141, and `git grep` finds `color-viz` in exactly three places — the
declarations, `design-system.md`, and the remaining-work lists themselves. No
component, script or test reads them.

## ⚠️ The defect is not the one five dev logs described

Every log from 0039 on describes it as _light palettes inherit chart colours
designed against a dark canvas_. Measured against a production build, with
`getComputedStyle` on a real page:

```
--color-viz-1 … -6, all five themes:  ""   (empty string)
--color-viz occurrences in the compiled stylesheet:  0
```

**Tailwind v4 tree-shakes `@theme` variables that nothing references**, and
nothing references these. A chart written today against `var(--color-viz-1)`
would not have rendered a wrong colour — it would have rendered **no colour**,
in every theme, including the two the sequence was tuned for.

Proven rather than inferred: the tree was reverted to `0407cc9`'s `tokens.css`,
rebuilt, and the compiled CSS searched. Zero. "Latent" was more literally true
than anyone intended.

⚠️ **This was invisible to every static check.** The tests parse `tokens.css`;
the compiler runs afterwards. It is the same shape as the cascade bug
[0040](0040-opening-a-browser.md) found — the values were right in the file and
wrong in the browser — and it was found the same way, by opening one.

## And two more defects, on top of that

**The whole sequence is below the contrast floor on three of five themes.**
WCAG 1.4.11 wants 3:1 for a graphical object that carries meaning:

| Theme           | viz-1 | viz-2 | viz-3 | viz-4 | viz-5 | viz-6 | below 3:1 |
| --------------- | ----: | ----: | ----: | ----: | ----: | ----: | --------: |
| `dark`          | 11.28 |  8.11 |  6.47 | 10.43 |  6.33 |  9.60 |     0 / 6 |
| `growth-dark`   | 11.11 |  7.99 |  6.37 | 10.27 |  6.24 |  9.46 |     0 / 6 |
| `light`         |  1.68 |  2.34 |  2.93 |  1.82 |  2.99 |  1.97 | **6 / 6** |
| `growth-bright` |  1.67 |  2.32 |  2.90 |  1.80 |  2.97 |  1.96 | **6 / 6** |
| `growth-warm`   |  1.67 |  2.32 |  2.90 |  1.80 |  2.97 |  1.96 | **6 / 6** |

**And the sequence never met its own documented claim, on any theme.** Both
`tokens.css` and `design-system.md` called it _"chosen for distinguishability
under both common colour-vision deficiencies and greyscale printing"_. On the
dark canvas, where it does render:

| Pair         | red-green dichromacy | greyscale |
| ------------ | -------------------: | --------: |
| azure/violet |            **0.003** |     0.087 |
| rose/teal    |            **0.012** |     0.174 |
| violet/rose  |                0.149 | **0.007** |

Six series carried **four distinct lightness values** — `viz-1`/`viz-4` both at
L 0.80, `viz-3`/`viz-5` both at L 0.68 — so two pairs were identical in
greyscale by construction. The claim was a comment, asserted by nothing.

## Five themes, two canvases

Contrast against the canvas is driven by lightness, and there are two:

| light 0.9558 · growth-bright 0.9466 · growth-warm 0.9464 | spread **0.004** |
| growth-dark 0.0039 · dark 0.0031 | spread **0.010** |

Deriving five sequences would invent differences no measurement supports. Two
derived sequences, each declared in every theme that uses it.

## The three decisions, and why they were put rather than taken

Per §3 the trade-offs were surfaced rather than guessed, because measurement
showed each had a real cost:

1. **Six series, accepting a ceiling.** On a light canvas the 3:1 requirement
   caps how dark a series may be, which caps the greyscale spread six series can
   occupy — measured ceiling **0.047** free, **0.045** keeping the documented
   hues; five series would reach 0.054. Six was kept: 0.045 is more than six
   times today's 0.007, and the design system already requires labels or markers
   so greyscale is a safety net, not the carrier.
2. **`viz-1` stays in the accent family.** `design-system.md` names it "signal
   green" deliberately. The other five must be clear of `--color-signal`, and
   all six clear of `--color-attention` — a series that reads as the warning
   colour misreports the data.
3. **One light sequence for all three light themes**, declared separately in
   each so the integrity test can enforce it.

⚠️ **Keeping the documented hue identities cost nothing, which was checked
rather than assumed.** Anchoring each slot to its documented hue (±20°) reaches
_better_ separation on light canvases than re-deriving hues freely — worst-pair
ΔE 0.182 against 0.167 — because the anchors already spread across the wheel.
An earlier greedy search said six were infeasible on a light canvas; that was
the search being weak, not the constraint being real, and a proper multi-restart
hill climb found solutions comfortably. Worth recording as a near-miss: a
"stop, this is impossible" report was one bad optimiser away.

⚠️ **The unconstrained optimum is degenerate.** Left alone the search maximises
separation by pushing series to the extremes: it proposed a near-black brown for
"amber" and a near-white for "violet". Chroma is floored at 0.09 and lightness
bounded per canvas class so each swatch still reads as its name. Same lesson as
[0047](0047-the-amber-that-was-two-ambers.md)'s dark-olive optimum, one task
later.

## The guard that already existed

`contrast.test.ts` asserted that every theme _"defines every semantic colour
ITSELF"_, with the rationale that _"a theme that inherited a colour from the
dark base would pass a merged check while rendering a dark-theme value on a
light surface — which is precisely the bug this guards"_.

**That is a description of this defect, written before it was found.** The guard
was correct; the viz tokens were simply missing from its list, so nothing ever
failed. They are in the list now.

## Testing

- `verify:all` exit 0: **1470 passed / 321 skipped (1791)**, against 1406 / 321
  (1727) at `0407cc9`. 29 boundary probes.
- `verify:e2e` exit 0: **77 passed**. Run, not skipped: `tokens.css` is in
  `packages/ui` and _is_ the design tokens, §7(3) names both, and the compiled
  CSS ships to the browser whether or not anything consumes these six.
- **Mutation-tested, five ways.** Restoring the old sequence into `growth-warm`
  fails 9; deleting `growth-bright`'s declarations fails 4; duplicating one
  colour onto another fails 3; neutering the dichromacy simulation fails its own
  validation test; moving the declarations back into the ordinary `@theme` block
  fails the tree-shaking guard.
- **Browser probe on a production build**, all five themes: every one of the six
  resolves, `light === growth-warm` and `dark === growth-dark` as intended, and
  `light !== dark`, which is the bug closed.

## What is unverified

**No chart was rendered, because there is still no chart.** Zero consumers, and
one was not built to have something to screenshot — the brief asked for a
negative result rather than a manufactured one. What was verified is that the
values reach the browser and resolve per theme; what cannot be verified yet is
how they look as a chart.

**The light sequence sits close to three of its five floors** (greyscale 0.045
against 0.04, normal 0.127 against 0.12, signal distance 0.095 against 0.09).
That is the structural ceiling, and it means a future tweak to any light theme's
accent could push it under.

**Greyscale separation is weak in absolute terms on light canvases** — 0.045 of
relative luminance is roughly 1.3:1 between the closest pair. Legible as a
difference, not as a ranking.

**The dichromacy simulation covers protanopia and deuteranopia only.**
Tritanopia was left out for the reason 0047 recorded: that arm never passed
validation, and an unvalidated number is worse than none.

## Result

The item flagged in 0039 and carried through eight dev logs is closed — and it
was a different item than the one being carried. The tokens now exist in the
browser, meet 3:1 on their own canvas in all five themes, and are separable in
normal vision, under red-green dichromacy, and in greyscale.

## Remaining work

1. **Red-green colour vision for `--color-signal` / `--color-attention`** across
   the three Growth themes — measured in 0047, still open, still needs either an
   accent move (reopens ADR-0057) or non-colour carriers.
2. **Optimistic `checked` in `ThemeSetting`** — carried from 0046.

⚠️ **Migrations, measured not carried:** disk **14**, test DB **14**. None added.
