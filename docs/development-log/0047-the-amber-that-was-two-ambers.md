# 0047 — The amber that was two ambers, and the rule that let it be

**Date:** 2026-08-21 · **Stage:** 4

## Objective

Close remaining-work item 1 from [0046](0046-the-signed-out-palette-decided.md),
carried on every list since [0041](0041-spending-the-accent.md): `growth-warm`'s
accent (hue 55) and `attention` (hue 82) are both amber and do not reliably read
as different signals.

## Initial state

Verified, not recalled: `153a0f0`, tree clean, `## main...origin/main` with no
divergence. `npm test` exit 0 at **1403 passed / 321 skipped (1724)**.

All three PostgreSQL ports on this machine were listening — `5432`, `55432`,
`55433`. The project's cluster is the one on **55432**
(`~/.growth-os/pgdata`, PID 11424), checked by name rather than by "something
answered", which is [0045](0045-a-preflight-that-lied.md)'s lesson.

## ⚠️ The rule was already there, it was already met, and the colour was still wrong

The brief asked me to check for an existing standard rather than invent a
number. There is one, and it changes the shape of the task:

> `growth-warm` introduces the first case where the accent and `attention` are
> drawn from the same colour family, so a new test requires them to differ by
> more than 20° of hue. — ADR-0057

`contrast.test.ts:275` enforced it. growth-warm passed at **27°**. So this was
never "meet the stated target" — the target was met by the defect.

**ADR-0057 picked 20 with nothing to calibrate against**, because growth-warm was
the only same-family pair in existence at the time. Measuring all five themes for
the first time shows what the number should have been:

| Theme           | signal H | attention H |      ΔH | ΔE (Oklab) |
| --------------- | -------: | ----------: | ------: | ---------: |
| `dark`          |      165 |          78 |     87° |      0.200 |
| `light`         |      165 |          62 |    103° |      0.197 |
| `growth-bright` |      133 |          62 |     71° |      0.156 |
| `growth-dark`   |      137 |          75 |     62° |      0.179 |
| **growth-warm** |   **55** |      **82** | **27°** |  **0.059** |

Four themes cluster at ΔE 0.156–0.200. growth-warm sat at 0.059 — **2.6× below
the weakest of them** — while green.

**Degrees of hue are a proxy and a poor one.** 27° of amber-against-amber
separates far less than 27° of amber-against-green, which is exactly how a
passing test coexisted with a reported defect for five dev logs. 0041 said this
in words; this entry has the number.

## ⚠️ Hue alone cannot fix it, and that is the theme's geometry rather than a lack of effort

Searched exhaustively over hue 60–115, L 0.34–0.62, C ≥ 0.09, requiring 4.5:1 on
canvas, surface-1 and surface-2, and sRGB gamut:

| Attention hue | best ΔE vs signal | reads as  |
| ------------: | ----------------: | --------- |
|            90 |             0.076 | yellow    |
|           100 |             0.095 | yellow    |
|           105 |             0.104 | mustard   |
|           110 |             0.114 | **green** |

**The ceiling staying warm is ΔE 0.114**, against a 0.156 floor everywhere else.
Two constraints produce it and neither is negotiable: growth-warm is a _light_
theme, so a status colour must stay dark enough for 4.5:1 on cream; and in the
dark warm band sRGB caps chroma near 0.11, which bounds the chord between two
warm colours however far you rotate one. Reaching 0.156 needs L ≈ 0.34 — dark
olive that reads as text, not as a status colour.

That finding is why this was put to a decision rather than picked: the honest
options all cost something, and which cost to pay is a product call.

## The decision — hue 105, weight unchanged

`--color-attention: oklch(0.535 0.114 105)`, ΔH 27° → **50°**, ΔE 0.059 →
**0.104**. Lightness and chroma held at today's values so no chip, border or
label changes weight anywhere. `--color-attention-dim` moves with it; a dim
variant one family away from the token it dims is the same defect quieter.

**105 rather than 110, giving up the last 0.010 deliberately.** At 110 the colour
visibly reads green, and green means "this is working" in every other theme in
this product. Trading legibility for a semantic collision is not a trade worth
making. Confirmed by rendering both, not by reasoning about numbers.

The rule changed too ([ADR-0060](../decisions/ADR-0060-growth-warm-attention-hue.md)):
ΔH floor 20° → **45°**, plus a **new perceptual check** at ΔE > 0.09 — the one
that would have caught this. Both, not one replacing the other: the angle is what
a designer reasons about, the distance is what the eye reports.

⚠️ **The rule is shared by all three Growth themes**, which the brief flagged as
a scope risk. It is not one: `growth-bright` (71°) and `growth-dark` (62°) clear
the new floor unchanged. No other palette's values moved. Confirmed by reverting
growth-warm's token and watching **only growth-warm** go red.

## ⚠️ Recorded, not fixed — red-green colour vision is a system-wide gap

The brief's stated rationale included colour vision deficiency. Measured, that
rationale does not scope to growth-warm.

Simulating dichromacy and measuring the _chromatic_ component that survives:

| Theme           | normal | protanopia | deuteranopia |
| --------------- | -----: | ---------: | -----------: |
| `dark`          |  0.200 |      0.085 |        0.138 |
| `light`         |  0.196 |      0.067 |        0.116 |
| `growth-bright` |  0.155 |  **0.015** |    **0.002** |
| `growth-dark`   |  0.178 |  **0.003** |        0.027 |
| `growth-warm`   |  0.058 |      0.011 |        0.005 |

**All three Growth themes collapse for a red-green dichromat and growth-warm is
not the worst.** ΔL between signal and attention is ~0.01 in all three, so there
is no lightness fallback either. `dark` and `light` survive because a teal accent
sits across the red-green axis instead of along it.

Decision taken: **record, do not fix.** Addressing it means moving the Growth
accents off leaf green — reopening ADR-0057's identity decision — or adding a
non-colour carrier to every status surface, which `accessibility.md`'s checklist
asks for and nothing enforces. Both are larger than a hue change.

⚠️ **Two simulations were written and discarded before this table.** The first
applied the transform to linear sRGB, the second to gamma-encoded sRGB with a
hardcoded inverse; both failed a validation step that required reproducing
textbook outcomes. The bug in my _reading_ was subtler than the bug in the code:
I expected red-vs-green to collapse to near-zero under protanopia, and it does
not — a dichromat separates them by **lightness**, and Oklab ΔE includes the L
axis. Measuring the chromatic component alone validates and is the right metric
here, because signal and attention sit at nearly the same L (0.52 vs 0.535) and
so have no lightness difference to fall back on.

Tritanopia never validated — blue-vs-yellow came back unchanged — so no
tritanopia number is reported. Red-green is the common case and the one the
brief named.

## Verified in a browser, not only in a calculator

§7 is explicit that a green `verify:all` has twice shipped browser-only theme
defects, and that `verify:e2e` does not test colour. So: production build,
`next start`, a seeded account moved to `growth-warm`, and the dashboard read
with `getComputedStyle` — the resolved values, not the source.

```
data-theme  = growth-warm
--color-signal    = lab(43.6271% 30.2392 52.4498)
--color-attention = lab(46.6652% -5.07459 52.162)
```

The `a` axis moves from **+30.2** to **−5.1**. Before and after were captured on
the same rendered page with the old values injected through CSSOM, so the only
difference in the pair of screenshots is the two tokens.

On the exact card 0041 complained about — "Attributed revenue +18%" beside
"Missed calls +9%" — the two deltas were both brown-amber and are now orange
against olive.

⚠️ **A side observation, not a defect introduced here.** `/dashboard` reached by
clicking through from `/login` renders `data-theme="growth-bright"`, because the
root layout does not re-render on client-side navigation. A direct load gives
`growth-warm`. That is exactly the Next.js behaviour ADR-0059 documents as the
reason the signed-out pin is keyed on the session rather than the route, seen
from the other side. Worth knowing before anyone screenshots a theme by
clicking to it.

## Testing

- `verify:all` exit 0: **1406 passed / 321 skipped (1727)**, against 1403 / 321
  (1724) at `153a0f0`. 29 boundary probes. The 3 new tests are the perceptual
  check, which runs once per Growth theme.
- `verify:e2e` exit 0: **77 passed**. Required — this changes design tokens,
  which §7(3) names explicitly.
- **Mutation-tested, not assumed:** restoring `oklch(0.53 0.108 82)` turns both
  gates red for `growth-warm` and leaves `growth-bright` and `growth-dark`
  green.

## What is unverified

**growth-warm still has the weakest signal/attention pair in the system**, at
ΔE 0.104 against 0.156–0.200. That is a stated ceiling, not a target met.

**No dark-surface check was made for growth-warm** because it does not have one:
it is a light theme, and all three of its surfaces are cream. The brief asked
for "light and dark-ish surface within growth-warm if applicable" — it is not
applicable, and `surface-2` is the darkest thing available.

**I have not looked at every screen that uses `attention`.** Nine components
reference the token; I verified the dashboard, which is where 0041 reported the
problem. The others inherit the same two variables and were not individually
reviewed.

**The red-green gap is measured and open**, on all three Growth themes.

## Result

The item flagged in 0041 and carried through 0044, 0045 and 0046 is closed. The
gate that let it pass for five dev logs now measures what the eye sees.

## Remaining work

1. **`--color-viz-*` per theme**, before Stage 5 ships charts. Still latent.
2. **Red-green colour vision across the three Growth themes** — new, measured
   above, and the largest accessibility gap now written down. Needs either an
   accent move (reopens ADR-0057) or non-colour carriers on status surfaces.
3. **Optimistic `checked` in `ThemeSetting`** — carried from 0046. The picker's
   selection dot waits a round-trip while the palette repaints instantly.

⚠️ **Migrations, measured not carried:** disk **14**, test DB **14**. None added.
