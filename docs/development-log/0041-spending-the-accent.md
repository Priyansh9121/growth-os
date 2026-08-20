# 0041 — Spending the accent, and a contrast rule that had never once applied

**Date:** 2026-08-20 · **Stage:** 4

## Objective

Make the Growth palettes deliver their intent on the dashboard, which
[0040](0040-opening-a-browser.md) found they did not — "Direction C" from a
reviewed mockup: coloured metric values, a left accent stripe on stat cards, and
a solid-accent primary CTA.

## Initial state

Verified, not recalled: `6119f1e`, tree clean, `0 0` against origin, remote
PRIVATE, PostgreSQL accepting on 55432. `verify:all` exit 0 at **1314 passed /
321 skipped (1635)**, 29 boundary probes.

## ⚠️ Two of the three changes were already shipped

Measured before writing anything, as §1 requires:

| Element                          | State before this session                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Positive deltas in accent colour | **Already done** — `DELTA_CLASSES.good = 'text-signal'`                             |
| Solid-accent primary CTA         | **Already done** — `Button` primary is `bg-signal`, and the dashboard's CTA uses it |
| Left accent stripe on cards      | Missing                                                                             |
| Large metric values in accent    | Missing — all `text-text`                                                           |

`design-system.md`'s own accent table already sanctions the first two:
_"Primary actions, active nav, **positive delta**, AI presence"_. They were never
exceptions to the ~5% rule; they were its documented intent.

The `~5%` rule itself is **convention only** — stated in three files
(`design-system.md:55`, `brand-direction.md:55`, `tokens.css:105`) and enforced
by no lint rule and no test.

## ⚠️ Stopped and asked, twice

The brief instructed a stop if Direction C would change Dark or Light. It would
have: nine stat cards each gaining an accent stripe, plus coloured values, in
two palettes whose entire purpose is restraint (ADR-0057: _"Dark and Light stay
for people who want the quiet version"_).

A second question the brief did not settle: **"positive metric value" is
undefined for most of the dashboard.** Five live CRM metrics — New contacts,
Qualified leads, Open opportunities, Pipeline value, Open tasks — carry **no
delta at all**, so there is no direction to judge.

Both were put to the human rather than decided. Answers: **Growth themes only**,
and **only values with a good delta**.

## What was built

Two tokens, off in the base and on in the three Growth blocks:

```css
--color-metric-emphasis: var(--color-text); /* base: no emphasis */
--color-card-accent: transparent;
```

⚠️ **The laziness is the safety property.** `var(--color-text)` is evaluated
where the token is _used_, not where it is declared. Had the base hard-coded the
dark theme's text colour, Light would have rendered its metric values near-white
on white. A sixth theme inherits "off" automatically.

**No component contains a `theme === '…'` branch.** One class name is a stripe
under Growth and nothing under Dark and Light — which is why a token test can
verify the whole rule.

`valueEarnsAccent` requires a delta **and** `deltaTone === 'good'`. Polarity, not
sign: "missed calls up 9%" is an increase and a bad result. The stripe is on
every card because it is structure, not judgement, and `border-l-2` is
unconditional so the box model is identical in all five themes.

## ⚠️ The finding: every primary button has been unreadable

Verifying the CTA's contrast — which the brief required — found it was not the
combination anyone thought.

`Button`'s primary variant is `bg-signal text-text-inverse`, and its own comment
justifies the inverse on contrast grounds. **`cn` was deleting the colour.**

`tailwind-merge` classifies `text-*` into a font-size group or a text-colour
group from its knowledge of Tailwind's **default** scale. This project's scale is
bespoke, so it recognised none of it and treated every `text-*` as one group.
`Button` composes variant-then-size; last-one-wins dropped `text-text-inverse`
from every button in the product.

Measured in the browser — the class is absent from the rendered `class`
attribute:

| Theme         |    Shipped | Intended |
| ------------- | ---------: | -------: |
| dark          | **1.61:1** |  11.06:1 |
| light         | **3.39:1** |   4.96:1 |
| growth-bright | **2.83:1** |   5.10:1 |
| growth-dark   | **1.47:1** |  12.12:1 |
| growth-warm   | **2.57:1** |   5.60:1 |

All five fail 4.5:1, including "Sign in" on the login page. **The comment
described a protection that had never once been in force**, and nothing caught
it: the class was in the source, the component rendered, and the only symptom
was a label that looked slightly washed out.

⚠️ **Scope delta, reported rather than absorbed silently:** the fix is in
`packages/ui/src/lib/cn.ts`, product-wide, where the brief was scoped to the
dashboard. It was unavoidable — the brief required inverse-on-accent to be
tested _and to pass_, and it cannot pass while the class is stripped.

## Verified in a browser, all five themes

Production build, Playwright, computed styles and screenshots.

**Dark and Light — unchanged, provably.** `--color-card-accent` computes to
`rgba(0, 0, 0, 0)` and `--color-metric-emphasis` to each theme's **own** text
colour: `lab(96.51)` for Dark, `lab(9.49)` for Light. The screenshots are
visually identical to 0040's: no stripes, numbers unchanged, deltas still
mint/teal.

**growth-bright** — stripes on all 10 cards; `82`, `36` and `$18,420` green;
`8 / 0 / 5 / $12,090 / 5` still dark because they have no delta; `11` dark with
its `+9%` in amber. Materially more energetic than the 0040 capture: the screen
now reads accented rather than monochrome, and three green numbers among nine
cards reads as _meaning something_.

**growth-dark** — the strongest result. Bright yellow-green stripes against
near-black genuinely glow. 0040 found that register only on the Appearance page;
the dashboard has it now.

**growth-warm** — amber stripes on cream, cohesive and warm.

The CTA label is now the inverse in all five, confirmed by computed style.

## What I would not claim

**The emotional target is my judgement, not a measurement.** I can show that the
accent now occupies substantially more of the screen and that the selection rule
is correct. Whether growth-bright now reads as "a hero arriving" is a
human call, and the mockup this followed was reviewed in growth-bright's colours
only.

⚠️ **growth-warm has a real legibility caution, reported not fixed.** Its accent
(hue 55) and `attention` (hue 82) are both amber. With more accent on screen, the
amber `+9%` on Missed calls is now harder to tell from the emphasised amber
values than it was. It passes ADR-0057's >20° hue-separation test at 27°, but
27° of amber-to-amber separates far less than amber-against-green. Retuning
palette values was explicitly out of scope.

**The stripe appears on the "Not connected" card**, which is a slightly odd
pairing — an accent stripe on a card reporting an absence. It follows from the
deliberate "stripe is structure, not judgement" decision, and it is worth a
second look if it grates in use.

## Testing

- `verify:all` exit 0: **1363 passed / 321 skipped (1684)**, against 1314 / 321
  (1635) at `6119f1e`. 29 boundary probes.
- `contrast.test.ts` 65 → 82; `cn.test.ts` new, 17; `metric-card.test.tsx` new, 15. There were **no dashboard component tests before this session**.
- `NODE_ENV=production npm run build` exit 0. (`npm run build` alone still fails
  from `.env.local`'s `NODE_ENV=development` — 0040's finding, still open.)

## Remaining work

1. **`NODE_ENV` in `.env.example`**, so `npm run build` works from a clean
   checkout. Carried from 0040, still the cheapest real fix outstanding.
2. **Decide the signed-out palette** — track the default, or pin it (0040).
3. **`growth-warm`'s accent/attention separation**, if the amber-on-amber proves
   as ambiguous in use as it looks here. Its own brief, with a sign-off step.
4. **`--color-viz-*` per theme**, before Stage 5 ships charts. Still latent.
5. **Get the e2e suite into a gate.** Two sessions running, the finding that
   mattered was invisible to `verify:all` by construction.

⚠️ **Migrations, measured not carried:** disk **14**, dev DB **14**, test DB
**14** — all level for the first time in four sessions. 0040 applied the
outstanding 0013 to the dev database.
