# ADR-0062 — Status colour is never the only carrier, and the red-green gap is closed at the surface rather than in the palette

**Status:** Accepted
**Scope:** `MetricCard` and `HeadlineMetric`'s delta readout, and the
signal-vs-attention dichromacy assertions in `contrast.test.ts`. **No token
value changes.** ADR-0057's accent identity and ADR-0060's separation rule are
both left in force, unamended.
**Date:** 2026-08-22

## Context

[Dev log 0047](../development-log/0047-the-amber-that-was-two-ambers.md) measured
that `--color-signal` and `--color-attention` collapse under simulated red-green
dichromacy in all three Growth themes, and recorded it explicitly as
_"record, do not fix"_. [ADR-0060](ADR-0060-growth-warm-attention-hue.md) repeated
the table and declined it again. [0048](../development-log/0048-the-chart-colours-were-never-there.md)
carried it forward unchanged. It has been the largest documented accessibility
gap in the theme system since.

0047 named exactly two ways out — move the Growth accents off leaf green, which
reopens ADR-0057's central identity decision, or add a non-colour carrier to
status surfaces — and said fixing this means choosing one.

## ⚠️ Re-measured first, and one of the carried numbers was stale

The simulation was re-validated before anything used it, per the discipline 0047
established after discarding two earlier attempts: textbook red/green loses more
than half its chromatic difference (0.462 → 0.146 protanopia, 0.075
deuteranopia), textbook blue/yellow survives at 0.727, and it reproduces **both**
previously published tables to three decimals from their historical inputs —
0047's five-theme table from `afdae01`'s tokens and 0048's viz pairs from
`0407cc9`'s.

Current values, measured at `60e50f8`:

| Theme           | signal H | attention H | ΔE normal | protanopia | deuteranopia |    worst |
| --------------- | -------: | ----------: | --------: | ---------: | -----------: | -------: |
| `dark`          |      165 |          78 |     0.200 |      0.085 |        0.138 |    0.085 |
| `light`         |      165 |          62 |     0.197 |      0.067 |        0.116 |    0.067 |
| `growth-bright` |      133 |          62 |     0.156 |      0.015 |        0.002 | ⚠️ 0.002 |
| `growth-dark`   |      137 |          75 |     0.179 |      0.003 |        0.027 | ⚠️ 0.003 |
| `growth-warm`   |       55 |     **105** |     0.104 |      0.018 |        0.008 | ⚠️ 0.008 |

⚠️ **`growth-warm` is 0.008, not the 0.005 carried since 0047.** ADR-0060 moved
its attention from hue 82 to 105 and the CVD number moved with it. The gain was
0.003 — the hue move bought legibility in normal vision and effectively nothing
for a dichromat, which is worth knowing about the shape of the problem.

⚠️ **Ranked by what a dichromat actually experiences, `growth-bright` is the
worst theme, not `growth-dark`.** Including the lightness that survives the
simulation, growth-bright separates by 0.009 against growth-dark's 0.027, because
growth-dark's chroma difference leaves a real greyscale gap and growth-bright's
does not. growth-bright is the default palette.

## ⚠️ The two named options were measured, and neither covers all three themes

### Option (a) — move the Growth accent hue

Swept with lightness free (±0.06) and chroma free (≥0.10), carrying every
existing constraint: 4.5:1 on canvas and surface-1, ADR-0060's ΔH > 45° and
ΔE > 0.09, ADR-0058's inverse-on-fill pair and its negative, sRGB gamut, and
ADR-0061's viz floors.

| signal hue | Δ from `dark`/`light`'s 165 | `growth-bright` | `growth-dark` | `growth-warm` |
| ---------: | --------------------------: | --------------: | ------------: | ------------: |
|  133 / 137 |                         30° |           0.002 |         0.003 |             — |
|        145 |                         20° |           0.036 |         0.075 |    infeasible |
|        155 |                         10° |           0.052 |         0.089 |         0.066 |
|    **165** |                      **0°** |           0.071 |         0.105 |         0.086 |

**The feasible region for any meaningful gain is hue 155–170** — which is 165 ± 10,
and 165 is exactly the hue ADR-0057 built the Growth identity in opposition to:

> The hue is the whole distinction. Dark and Light use hue **165** … The Growth
> palettes use **~133–140**, a leaf green that reads as _growth_ and _season_.
> Thirty degrees apart is a different idea, not a lighter version of the same one.

Thirty degrees becomes ten, or zero.

⚠️ **A second cost the earlier framing did not name: chroma collapses too.** Every
feasible teal-ward value sits at the 0.10 chroma floor, because high-chroma teal
at these lightnesses is outside sRGB. `growth-dark` would fall from 0.19 to 0.10
— and ADR-0057 states that its chroma 0.19 is _"what makes it read as glowing
rather than merely visible"_.

⚠️ **And it cannot cover `growth-warm` at all.** The phrase carried since 0047 —
"move the Growth accents off leaf green (~133–140)" — describes two themes.
`growth-warm`'s accent is **amber at hue 55**. No green signal below hue 155 is
even feasible for it (its attention sits at 105, so ΔH > 45° fails), and a
teal-green accent abolishes the premise ADR-0057 gives the theme: _"green says
the chart is up and amber says someone is looking after this"_.

**Moving `attention` instead was measured and is dead.** `--color-critical` sits
at hue 25 in all five themes, so attention must clear it by the same rule
ADR-0060 applied to signal. With that enforced, the entire warm band yields
growth-bright 0.019, growth-dark 0.036, growth-warm 0.010 — all still collapsed.
Escaping requires magenta (hue 320) or blue-violet (254–289), at which point
attention has stopped being a warning colour.

### Option (b) — a non-colour carrier on status surfaces sitewide

Audited at component level rather than assumed. **Almost every surface already
has one**, which none of the prior logs had checked:

| Surface                                                                                  | Carrier already present                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| Every `Badge` — tasks, opportunities, source, submissions, forms, imports, import wizard | the badge's own text label                    |
| `import-wizard`'s `Count`                                                                | "Will import" / "Cannot import"               |
| Dashboard "Mixed data", duplicate warning, embed "not live yet", merge-panel             | the sentence is the message                   |
| `activity-timeline` and `pipeline-board` dots                                            | `aria-hidden`; the row text carries the event |

Applying carriers sitewide would add redundant markers to eleven of twelve
components that do not need them.

## ⚠️ One surface fails, and it is the one dev log 0041 complained about

Proven by rendering, not by reading the source:

```
{"visibleText":"+18% vs previous 30 days","className":"… text-signal"}     ← Attributed revenue
{"visibleText":"+9% vs previous 30 days", "className":"… text-attention"}  ← Missed calls
```

`metric-card.tsx` prints the sign from **direction** and colours from
**polarity × direction**. Both render `+`. Nothing in the text, the accessible
name, `aria-label` or `title` says one is a good result and the other is not.

⚠️ **And the same element announced nothing either.** The `sr-only` span carried
the comparison window and not the judgement, so a screen-reader user with
ordinary colour vision was in exactly the same position. This was never only a
colour-vision defect.

## Decision 1 — the judgement gets a carrier; no token moves

`MetricCard` and `HeadlineMetric` render the delta through one shared
`DeltaReadout`:

- a glyph that differs by **tone**, not by direction — `✓` for a good movement,
  `!` for a bad one, nothing for a neutral one. `aria-hidden`, because the phrase
  below says the same thing in words and "check mark, a good result" is noise;
- an `sr-only` phrase — _"a good result"_ / _"needs attention"_ — alongside the
  comparison window that was already announced;
- the existing colour, unchanged. It is redundant now rather than load-bearing,
  which is what `accessibility.md`'s review checklist has asked for since Stage 1
  and nothing enforced.

The sign still reports direction, because direction is a fact and judgement is an
interpretation, and ADR-0058 already turns on keeping those apart.

⚠️ **Extracting the shared readout fixed a drift between the two cards.**
`MetricCard` handled a `flat` delta and `HeadlineMetric` did not — it rendered
`−` on a metric that had not moved. Two copies of the same expression, one of
which never handled the third case. A test pins it in both.

## Decision 2 — the guard is a measurement, and a tripwire, not a floor

`contrast.test.ts` gains the chromatic dichromacy metric and four assertions:

- `dark` and `light` **survive** (> 0.06) — the fact the whole comparison rests on;
- the three Growth themes **collapse** (< 0.05), written as an upper bound in the
  same shape as the existing _"the ordinary text colour would NOT be readable"_
  assertion. It records a measured limitation rather than a target, and if it ever
  fails that is good news which makes this ADR's reasoning stale;
- the chromatic metric reproduces ADR-0060's published numbers from ADR-0060's
  inputs — `growth-warm`'s attention has moved since, so it cannot pass by
  accidentally re-measuring today's file;
- the two metrics agree where the pair survives (1.28–1.31×) and diverge where it
  collapses (3.78–10.56×).

⚠️ **The metric is the chromatic component, and that is not what
`dichromatDistance` returns.** That function includes lightness, which is correct
for the viz sequence — six series free to differ in lightness — and wrong here:
signal and attention sit within 0.02 of each other in L in every theme, so
everything the fuller metric still reports is a lightness difference nobody
designed. Both dev logs published chromatic numbers; the two disagree by up to
10.56× on the same pair, so the choice is load-bearing rather than pedantic.

## ⚠️ Colour alone was never sufficient anywhere except `dark`

ADR-0061 requires every pair of **chart** colours to separate by more than 0.10
under dichromacy. Measured against that same bar, the signal/attention pair — which
carries far more meaning than any decorative series — clears it in exactly one
theme:

| Theme           | signal/attention, dichromacy ΔE | clears ADR-0061's 0.10 |
| --------------- | ------------------------------: | :--------------------: |
| `dark`          |                           0.109 |           ✓            |
| `light`         |                           0.088 |           ✗            |
| `growth-bright` |                           0.009 |           ✗            |
| `growth-dark`   |                           0.027 |           ✗            |
| `growth-warm`   |                           0.036 |           ✗            |

This is why the carrier is unconditional rather than applied to the Growth themes
only. A fix scoped to the palettes that "have the problem" would have left
`light` one hundredth above the line and called it well.

## Consequences

- The dashboard reports its judgement to a protanope, a deuteranope, a
  greyscale printer and a screen reader, in all five themes.
- **No token value changed**, so ADR-0057's leaf-green identity, ADR-0060's
  separation floors and ADR-0061's freshly derived viz sequences are all
  untouched. The viz interaction was checked rather than assumed: with no token
  moving, `viz-2`…`viz-6` keep today's margins against signal (0.147 / 0.192 /
  0.143 against a 0.09 floor).
- ⚠️ **The palettes still measure 0.002–0.008 and this ADR does not claim
  otherwise.** What changed is that nothing depends on that number any more.
  Anyone reading the token table should read this ADR before concluding the
  colours are fine.
- ⚠️ **`--color-signal` against `--color-critical` collapses too, in every theme
  including the two that survive** — 0.020 in `dark`, 0.025 in `light`, 0.050
  in `growth-bright`, 0.053 in `growth-dark`, 0.050 in `growth-warm`. Green-for-good
  against red-for-bad is the canonical red-green pair and no palette can fix it.
  Measured here, not addressed here: the surfaces using that pair
  (`activity-timeline`, `pipeline-board`) already carry their meaning in text, so
  it is recorded rather than opened.
- The review checklist item _"Is colour the only carrier of any meaning?"_ gains
  its first enforcement in `accessibility.md`'s commitments table.
