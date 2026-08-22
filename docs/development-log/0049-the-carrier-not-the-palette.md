# 0049 — The carrier, not the palette

**Date:** 2026-08-22 · **Stage:** 4

## Objective

Close remaining-work item 1 from [0048](0048-the-chart-colours-were-never-there.md),
carried since [0047](0047-the-amber-that-was-two-ambers.md): `--color-signal`
and `--color-attention` collapse under simulated red-green dichromacy in all
three Growth themes. 0047 named two ways out and said fixing this meant
choosing one, so this entry is an investigation and a decision before it is a
change.

## Initial state

Verified, not recalled: `60e50f8`, tree clean, `## main...origin/main` with no
divergence. `npm test` exit 0 at **1470 passed / 321 skipped (1791)**.

Two PostgreSQL clusters were listening — `55432` and `55433`. The project's is
the one on **55432** (`~/.growth-os/pgdata`, PID 11424), identified by data
directory rather than by "something answered" ([0045](0045-a-preflight-that-lied.md)).

## The simulation was re-validated three ways before anything used it

The brief required this explicitly and it was worth the ten minutes: 0047
discarded two simulations for failing exactly this step, and a validated
version existing in the file is not the same as it still validating.

- **Textbook red/green** — chromatic difference 0.462 → 0.146 (protanopia) and
  0.075 (deuteranopia), both under the 50% bar. Full ΔE stays 0.356, reproducing
  0047's point that a dichromat separates red from green by _lightness_.
- **Textbook blue/yellow** — survives at 0.727 against a 0.3 floor.
- **Both published tables reproduced from their historical inputs.** Fed
  `afdae01`'s pre-ADR-0060 tokens it reproduces 0047's five-theme table to three
  decimals; fed `0407cc9`'s pre-ADR-0061 viz values it reproduces 0048's
  azure/violet 0.003, rose/teal 0.012 and violet/rose greyscale 0.007.

⚠️ **That third check found something neither log records.** 0048's prose table
and `contrast.test.ts`'s enforced assertion are **not the same metric**. The
table quotes the chromatic component; `dichromatDistance()` includes lightness.
The same viz pairs measure 0.003 / 0.012 / 0.149 chromatically and
0.021 / 0.131 / 0.178 under the enforced one. Neither is wrong. The enforced
floor is a weaker guarantee than the published table reads as, and the first
attempt at this session's own assertion got it wrong in the same direction —
it claimed an order-of-magnitude gap that measurement put at 3.78×.

## Current state, and one carried number was stale

| Theme           | signal H | attention H | ΔE normal | protanopia | deuteranopia |    worst |
| --------------- | -------: | ----------: | --------: | ---------: | -----------: | -------: |
| `dark`          |      165 |          78 |     0.200 |      0.085 |        0.138 |    0.085 |
| `light`         |      165 |          62 |     0.197 |      0.067 |        0.116 |    0.067 |
| `growth-bright` |      133 |          62 |     0.156 |      0.015 |        0.002 | ⚠️ 0.002 |
| `growth-dark`   |      137 |          75 |     0.179 |      0.003 |        0.027 | ⚠️ 0.003 |
| `growth-warm`   |       55 |     **105** |     0.104 |      0.018 |        0.008 | ⚠️ 0.008 |

⚠️ **`growth-warm` is 0.008, not the 0.005 the brief carried from 0047.**
ADR-0060 moved its attention from hue 82 to 105 and the CVD number moved with
it — by 0.003. That hue move bought real legibility in normal vision and
effectively nothing for a dichromat, which says something about the shape of
the problem that neither prior log states.

⚠️ **Ranked by what a dichromat actually experiences, `growth-bright` is the
worst theme, not `growth-dark`.** Including the lightness that survives the
simulation: growth-bright 0.009, growth-dark 0.027. growth-dark's larger chroma
difference leaves a real greyscale gap (ΔY 0.068); growth-bright's does not
(0.008). growth-bright is the default palette.

## ⚠️ Option (a) was measured properly, and it cannot cover all three themes

Swept with lightness free (±0.06) and chroma free (≥0.10), carrying every
existing constraint: 4.5:1 on canvas and surface-1, ADR-0060's ΔH > 45° and
ΔE > 0.09, ADR-0058's inverse-on-fill pair _and its negative_, sRGB gamut, and
ADR-0061's viz floors.

| signal hue | Δ from `dark`/`light`'s 165 | `growth-bright` | `growth-dark` | `growth-warm` |
| ---------: | --------------------------: | --------------: | ------------: | ------------: |
|  133 / 137 |                         30° |           0.002 |         0.003 |             — |
|        145 |                         20° |           0.036 |         0.075 |    infeasible |
|        155 |                         10° |           0.052 |         0.089 |         0.066 |
|    **165** |                      **0°** |           0.071 |         0.105 |         0.086 |

**The feasible region for any meaningful gain is hue 155–170** — 165 ± 10, and
165 is precisely what ADR-0057 built the Growth identity in opposition to.
Thirty degrees becomes ten, or zero.

⚠️ **A second cost nobody had named: chroma collapses too.** Every feasible
teal-ward value sits at the 0.10 chroma floor, because high-chroma teal at these
lightnesses is outside sRGB. `growth-dark` would fall 0.19 → 0.10, and ADR-0057
says that 0.19 is _"what makes it read as glowing rather than merely visible"_.

⚠️ **And the phrase carried since 0047 describes two themes, not three.**
"Move the Growth accents off leaf green (~133–140)" is not what `growth-warm`
is. Its accent is **amber at hue 55**. No green signal below hue 155 is even
feasible for it, and a teal-green accent deletes the premise ADR-0057 gives the
theme.

**Moving `attention` instead is dead, and the reason is `--color-critical`.** It
sits at hue 25 in all five themes, so attention must clear it by the same rule
ADR-0060 applied to signal. With that enforced the whole warm band yields
growth-bright 0.019, growth-dark 0.036, growth-warm 0.010 — all still collapsed.
Escaping needs magenta (320) or blue-violet (254–289), at which point it is not
a warning colour.

## ⚠️ Option (b) is eleven-twelfths already done, which nobody had checked

Audited at component level rather than assumed. Every `Badge` renders
`<Badge tone={…}>{LABEL}</Badge>` — tasks, opportunities, source, submissions,
forms, imports. `import-wizard`'s `Count` puts its number above "Will import" /
"Already in the CRM" / "Cannot import". Every attention-coloured prose block
_is_ its own message. `activity-timeline` and `pipeline-board` dots are
`aria-hidden` with the row text carrying the event.

**One surface fails.** Proven by rendering it, not by reading it:

```
{"visibleText":"+18% vs previous 30 days","className":"… text-signal"}     ← Attributed revenue
{"visibleText":"+9% vs previous 30 days", "className":"… text-attention"}  ← Missed calls
```

`metric-card.tsx` prints the sign from **direction** and colours from
**polarity × direction**. Both render `+`. This is the card
[0041](0041-spending-the-accent.md) complained about, still unfixed four logs
later, and the reason it survived is that the defect is in what the two have in
common rather than in either one.

⚠️ **The same element announced nothing either.** The `sr-only` span carried the
comparison window and not the judgement, so a screen-reader user with ordinary
colour vision was in exactly the same position. This was never only a
colour-vision defect, and that reframing is what made the decision easy.

## The decision — a carrier, put rather than taken

Per §3 the three options were presented with measurements and the choice was
made by the product owner, not inferred: **option (c), a carrier on the metric
delta.** `✓` for a good movement, `!` for a bad one, `aria-hidden` because an
`sr-only` phrase says the same thing in words; the colour left in place and
redundant.

⚠️ **The measurement that made the carrier unconditional rather than
Growth-only.** ADR-0061 requires every pair of _chart_ colours to separate by
more than 0.10 under dichromacy. Held to its own bar, the signal/attention pair
clears it in exactly one theme:

| Theme           | dichromacy ΔE | clears 0.10 |
| --------------- | ------------: | :---------: |
| `dark`          |         0.109 |      ✓      |
| `light`         |         0.088 |      ✗      |
| `growth-bright` |         0.009 |      ✗      |
| `growth-dark`   |         0.027 |      ✗      |
| `growth-warm`   |         0.036 |      ✗      |

A fix scoped to "the themes with the problem" would have left `light` one
hundredth above the line and called it well.

⚠️ **Extracting one shared readout fixed a drift found on the way.**
`MetricCard` handled a `flat` delta; `HeadlineMetric` rendered `−` on a metric
that had not moved. Two copies of one expression, one of which never handled the
third case.

## Interaction with `--color-viz-*` — checked, not assumed

**No token value changed**, so the freshly derived sequences are untouched:
`viz-2`…`viz-6` keep 0.147 / 0.192 / 0.143 against signal on the three Growth
themes, over a 0.09 floor. Measured rather than argued from "we changed no
colours": had option (a) been chosen, growth-bright's margin would have fallen
from 0.147 to 0.120, with `viz-6`'s teal as the closing series.

## Testing

- `verify:all` exit 0: **1487 passed / 321 skipped (1808)**, against 1470 / 321
  (1791) at `60e50f8`. 29 boundary probes. +17: nine component assertions, eight
  token assertions.
- `verify:e2e` exit 0: **77 passed**. Required — this changes a component that
  renders on the dashboard.
- **Mutation-tested nine ways.** Component: removing the glyph fails 3,
  removing the announcement fails 3, rendering one glyph for both tones fails 1,
  un-hiding the glyph fails 3, restoring minus-on-flat fails 2, and removing both
  carriers — the pre-change behaviour — fails 5 **including the strong property**,
  which asserts two deltas with the same number, the same direction and opposite
  polarity render different text. Tokens: neutering the chromatic gap fails 2,
  moving growth-bright's accent to teal fails 2, moving dark's accent onto the
  confusion axis fails 3.

⚠️ **Two mutations initially reported "24 passed" because the mutation had not
applied** — a heredoc quoting error swallowed the edit. A mutation test that
silently fails to mutate reports the same thing as a test that cannot fail.
Both were re-run with the edit asserted before the suite ran.

⚠️ **`verify:e2e` cannot run without `TEST_DATABASE_URL` exported**, which lives
in `apps/web/.env.local` and is deliberately not exported to the shell. The
preflight refused correctly and named the cause, but its message said _"the port
is answering"_ about 127.0.0.1:5432 while nothing this session could find was
listening there. Not chased; recorded because the next person will hit it.
