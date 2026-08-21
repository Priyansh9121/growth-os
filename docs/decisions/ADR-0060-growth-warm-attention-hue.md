# ADR-0060 — growth-warm's attention colour moves to hue 105, and the rule that let it drift becomes perceptual

**Status:** Accepted
**Scope:** `growth-warm`'s `--color-attention` / `--color-attention-dim`, and the
signal-vs-attention separation rule in `contrast.test.ts`, which applies to all
three Growth themes. No other palette's values change.
**Date:** 2026-08-21

## Context

[Dev log 0041](../development-log/0041-spending-the-accent.md) reported a
legibility caution and did not fix it:

> growth-warm has a real legibility caution, reported not fixed. Its accent
> (hue 55) and `attention` (hue 82) are both amber. … It passes ADR-0057's
>
> > 20° hue-separation test at 27°, but 27° of amber-to-amber separates far less
> > than amber-against-green.

It has been on the remaining-work list of 0041, 0044, 0045 and 0046 since.

## ⚠️ The rule was met, and the colour was still wrong

ADR-0057 introduced the >20° rule when `growth-warm` was the **only** theme with
an accent and an `attention` from the same family — so there was nothing to
calibrate the number against, and 20 was a guess that happened to sit below 27.

Measured across all five themes for the first time:

| Theme           | signal H | attention H |      ΔH | ΔE (Oklab) |
| --------------- | -------: | ----------: | ------: | ---------: |
| `dark`          |      165 |          78 |     87° |      0.200 |
| `light`         |      165 |          62 |    103° |      0.197 |
| `growth-bright` |      133 |          62 |     71° |      0.156 |
| `growth-dark`   |      137 |          75 |     62° |      0.179 |
| **growth-warm** |   **55** |      **82** | **27°** |  **0.059** |

The four themes with no collision cluster at ΔE **0.156–0.200**. growth-warm sat
at **0.059** — 2.6× below the weakest of them, while passing the gate.

**Degrees of hue are a proxy, and a poor one.** 27° of amber-against-amber
separates far less than 27° of amber-against-green, because perceptual distance
depends on where in the wheel the arc sits and on how much chroma the two
colours carry. That is precisely how a green test coexisted with a reported
defect for five dev logs.

## ⚠️ Hue alone cannot reach parity here, and that is structural

Searched exhaustively over hue 60–115, L 0.34–0.62, C ≥ 0.09, requiring 4.5:1 on
canvas, surface-1 and surface-2 and sRGB gamut:

| Attention hue | best ΔE vs signal | reads as  |
| ------------: | ----------------: | --------- |
|            90 |             0.076 | yellow    |
|           100 |             0.095 | yellow    |
|           105 |             0.104 | mustard   |
|           110 |             0.114 | **green** |

**The ceiling staying warm is ΔE 0.114**, against a 0.156 floor elsewhere.
Two constraints produce it and neither is negotiable: growth-warm is a _light_
theme, so a status colour must stay dark enough for 4.5:1 on cream; and in the
dark warm band sRGB caps chroma near 0.11, which bounds the chord between any
two warm colours however far you rotate them. Reaching 0.156 requires L ≈ 0.34,
which renders as dark olive text rather than as a status colour.

## Decision 1 — `attention` becomes `oklch(0.535 0.114 105)`

ΔH 27° → **50°**. ΔE 0.059 → **0.104**, a 1.8× improvement.

Lightness and chroma are held at today's values (0.53 → 0.535, 0.108 → 0.114) so
no attention chip, border or label changes weight anywhere in the product. Only
the hue moves.

**105 rather than 110**, giving up the last 0.010 of separation deliberately:
at 110 the colour visibly reads _green_, and green means "this is working" in
every other theme in this product. Trading a legibility gain for a semantic
collision is not a trade worth making. 105 is the last hue that still reads as
mustard rather than lime — confirmed by rendering both, not by reasoning about
the numbers.

`--color-attention-dim` moves to hue 105 with it. A dim variant one family away
from the token it dims is the same defect at lower contrast.

⚠️ **This does not reach the other themes' separation and is not claimed to.**
growth-warm remains the weakest pair in the system at ΔE 0.104. The alternative
was changing what the theme is.

## Decision 2 — the rule gains a perceptual check, and the angular floor moves to 45°

The shared rule in `contrast.test.ts` applies to all three Growth themes:

- **ΔH > 45°** — above growth-warm's old 27°, below every working theme
  (62°, 71°, and growth-warm's new 50°). `growth-bright` and `growth-dark` clear
  it unchanged; no other palette's values move.
- **ΔE > 0.09 in Oklab** — new, and the one that would have caught this. Measured
  today: growth-warm 0.104, growth-bright 0.156, growth-dark 0.179.

Two checks rather than one replacing the other: the angle is what a designer
reasons about, and the perceptual distance is what the eye reports. Keeping both
means a future pair cannot satisfy the geometry and fail the eye again.

## ⚠️ Recorded, not fixed — red-green colour vision is a system-wide gap

Simulating dichromacy (Viénot/Brettel/Mollon, validated against textbook pairs
before use) and measuring the _chromatic_ component that survives:

| Theme           | normal | protanopia | deuteranopia |
| --------------- | -----: | ---------: | -----------: |
| `dark`          |  0.200 |      0.085 |        0.138 |
| `light`         |  0.196 |      0.067 |        0.116 |
| `growth-bright` |  0.155 |  **0.015** |    **0.002** |
| `growth-dark`   |  0.178 |  **0.003** |        0.027 |
| `growth-warm`   |  0.058 |      0.011 |        0.005 |

**All three Growth themes collapse for a red-green dichromat, and growth-warm is
not the worst of them.** `growth-dark` separates by 0.003 under protanopia and
`growth-bright` by 0.002 under deuteranopia. Lightness offers no fallback —
ΔL between signal and attention is ~0.01 in all three. `dark` and `light`
survive because their teal accent sits across the red-green axis rather than
along it.

This ADR does **not** address it. Doing so means either moving the Growth
accents off leaf green — reopening ADR-0057's central identity decision — or
adding a non-colour carrier to every status surface, which
`accessibility.md`'s review checklist already asks for (_"Is colour the only
carrier of any meaning?"_) and nothing enforces. Both are larger than a hue
change and neither should be decided as a side effect of one.

It is recorded here, measured, and carried as its own remaining-work item.

## Consequences

- growth-warm's `attention` reads as mustard rather than amber. It is no longer
  confusable with the accent at a glance, and it is still a warm colour.
- The separation gate is real for the first time: both halves of it fail if the
  old value is restored, verified by reverting the token and watching them go
  red for `growth-warm` only.
- growth-warm keeps the weakest signal/attention pair in the system, by a
  structural margin that is now written down rather than rediscovered.
- The red-green CVD gap is documented with numbers and remains open across all
  three Growth themes.
