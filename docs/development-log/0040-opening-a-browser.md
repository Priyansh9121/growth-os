# 0040 — Opening a browser, and finding three of the five themes never rendered

**Date:** 2026-08-20 · **Stage:** 4

## Objective

Verify visually what [0039](0039-the-growth-palettes.md) verified only
mathematically, and report honestly on whether the Growth palettes hit their
stated emotional target.

0039 closed with: _"nothing rendered these palettes… whether growth-warm's amber
actually feels warm, or growth-dark reads as glowing rather than murky, is
unmeasured and unseen."_ This is that step.

## Initial state

Verified, not recalled: `a11c670`, tree clean, remote PRIVATE, `verify:all` exit
0 at **1307 passed / 321 skipped (1628)**, 29 boundary probes.

⚠️ **Three commits ahead of `origin/main` and unpushed** — 0039's slices, left
by an interrupted session.

⚠️ **Migrations, measured rather than carried** (the last three sessions each got
this wrong in a first draft): disk **14**, dev DB **13**, test DB **14**.
Migration 0013 had never been applied to the dev database, so its
`theme_preference` enum held only `dark, light`. Applied it before anything
else — otherwise the settings page would have offered five options and failed on
save. The three existing accounts kept their stored values (2 `dark`, 1
`light`), confirming ADR-0057's compatibility claim against the real dev
database rather than a throwaway.

## ⚠️ The finding: three of the five themes did not render

`tokens.css` guarded the OS-preference block with
`:root:not([data-theme='dark'])`. That selector has specificity **(0,2,0)** —
identical to `:root[data-theme='growth-bright']` — and sits **later** in the
file, so it won on source order against every theme except `dark`.

On any machine whose OS prefers light — the common default — **all three Growth
palettes rendered as the plain Light theme, and `growth-dark` rendered LIGHT**,
with `color-scheme: light` handed to its form controls and scrollbars.

Measured in Chromium under both preferences:

| Theme           | `prefers-color-scheme: light` | `prefers-color-scheme: dark` |
| --------------- | ----------------------------- | ---------------------------- |
| `dark`          | `lab(2.73%)` ✓                | `lab(2.73%)` ✓               |
| `light`         | `lab(98.26%)` ✓               | `lab(98.26%)` ✓              |
| `growth-bright` | **`lab(98.26%)`** ✗           | `lab(97.91%)` ✓              |
| `growth-dark`   | **`lab(98.26%)`** ✗           | `lab(3.50%)` ✓               |
| `growth-warm`   | **`lab(98.26%)`** ✗           | `lab(97.94%)` ✓              |

It was harmless while `dark` and `light` were the only values: the one theme it
wrongly matched was `light`, and the values it imposed were light's own. **The
third theme is what turned a latent wrong selector into a visible bug.**

Fixed to `:root:not([data-theme])` — attribute **absence**, which is what "has
not made an explicit choice" always meant. Both occurrences: the token block and
the `color-scheme` block in `@layer base`.

### ⚠️ Why the suite stayed green through all of it

Every existing test reads token **values** out of a block. The values were
correct; only the cascade was wrong, and a static parser cannot see a cascade.
0039's own contrast suite went 18 → 58 tests and could not have caught this.

The new describe block pins the property statically in the fast gate, because a
browser is the only place the real cascade shows and the e2e suite is not in
`verify:all`. Reintroducing the defect fails six tests naming it exactly;
restoring the fix returns 65 passed.

## What was actually seen, per theme

Screenshots at 1440×900, production build, seeded `sam@abcplumbing.test`.

**Dark** — cool blue-black graphite. Deltas are a mint/teal green. Reads as a
calm instrument panel. Correct and unremarkable, which is its brief.

**Light** — clean near-white, dark green-grey accent. Legible, professional.

**Growth Bright (default)** — canvas is a faint green-tinted off-white; cards
white with hairlines. The accent appears in the "Home" nav pill, the logo, and
the `+4% / +12% / +18%` deltas.

**Growth Dark** — near-black with a green cast, warmer than plain Dark. The
deltas are a distinctly yellower green than Dark's teal.

**Growth Warm** — a genuinely warm cream canvas with warm-brown text. The most
distinctive of the five at a glance.

## ⚠️ Honest read against the stated emotional targets

**`growth-bright` — "confident, decisive, a hero arriving to fix this
business".** On the **dashboard: no.** It reads calm, clean and competent — good
work, but closer to well-made SaaS than to a hero arriving. The reason is
structural rather than a fault in the palette: the design system caps the accent
at _"≲5% of a screen"_, and on a data-dense dashboard that leaves the green in a
nav pill, a logo and four tiny percentages. Every large number is near-black, so
the screen's visual weight is monochrome.

On the **login page: yes.** Big green CTA, green lattice, spring-green canvas —
that screen genuinely lands the intent. **The palette can deliver the register;
the dashboard's accent discipline is what prevents it.** It is not generic or
flat: the tinted canvas and green nav pill do separate it from a stock grey
admin theme.

**`growth-dark` — "glowing / in motion" vs plain Dark.** **Perceptible, but
subtle.** Side by side the canvas is warmer and the accent visibly yellower than
Dark's teal. Shown alone, nobody would call it glowing. The exception is the
Appearance page, where the selected row carries a bright green border across a
large element — there the accent genuinely glows. Same conclusion as above: the
palette has the range, the dashboard does not spend it.

**`growth-warm` — "warm/human, not a hue-shifted growth-bright".** **Yes, clearly
the most successful of the three.** The warm-brown text is what does it — it
changes the register in a way a background tint alone would not, and reads more
like paper than like a screen.

One caution, reported not fixed: in `growth-warm` the accent (hue 55) and
`attention` (hue 82) are both amber, so the amber "DEMO" badges no longer pop the
way they do against green. They pass 0039's >20° hue-separation test at 27°, but
27° of amber-to-amber is much less separation than amber-against-green.

## Confirmed by direct observation

- **Reload preserves the choice** for all five, every time — proving server-side
  resolution end to end, not just the client toggle.
- **No flash**, structurally: `data-theme="growth-bright"` appears within the
  first 400 bytes of the raw server HTML, before any stylesheet.
- **The signed-out login page does NOT render Dark.** It renders
  `growth-bright`, and still does with `growth-warm` saved to the account — so
  it correctly ignores the preference and uses the default. See below.
- **The Appearance page is legible in its own theme** in all five: five labels,
  five descriptions, a visible selected state.

### ⚠️ The brief's premise about the login page was wrong

The brief asked to _"confirm the login page always renders Dark… since
ADR-0056/0057 specify no theme applies before authentication"_.

That is not what they specify. `resolveRequestTheme` returns
`DEFAULT_THEME_PREFERENCE` when signed out, and ADR-0056 words it as _"the
default"_ — which ADR-0057 changed to `growth-bright`. **The code is behaving to
spec; the brief mis-stated the spec.**

So this is a product question, not a bug, and it is left unchanged and unasked-
for: _should the signed-out surface track the product default, or be pinned to
one palette?_ Today a change of default silently restyles the logged-out
marketing surface, which nobody decided.

Two comments were corrected as part of the fix, comments-only: `layout.tsx` said
"Dark for a signed-out visitor" and `theme.ts` said a failure "still renders, in
dark". Both became false when the default moved.

## The data-viz gap: not reachable today

0039 flagged that no theme overrides `--color-viz-*`, so light palettes inherit
chart colours designed for a dark canvas. Measured:

- **No consumer of any `--color-viz-*` token exists in application source.**
- No chart library is a dependency of `apps/web`.
- The dashboard renders 3 `<svg>` elements (icons) and 0 `<canvas>`.

**It is latent, not visible.** Nothing reachable today surfaces it. It stays a
real item for before Stage 5 ships charts, and is not a defect now.

## Also found

⚠️ **`npm run build` fails as written on this machine.** `.env.local` sets
`NODE_ENV=development`, which `next build` warns about and which breaks the
`/_global-error` prerender with `Cannot read properties of null (reading
'useContext')`. `NODE_ENV=production npm run build` succeeds. The tracked
`.env.example` ships `NODE_ENV=development`, so every developer inherits this,
and `playwright.config.ts` already works around it by forcing
`NODE_ENV: 'production'` in its `webServer` env.

Reported, not fixed: it is an environment/tooling question outside this brief,
and the fix could be to `.env.example`, to the `build` script, or to neither.

**The local Postgres cluster stopped mid-session** (smart shutdown at 14:53:48,
not a crash) and was restarted from `~/.growth-os/pgdata` with its recorded
options. Noted because the first login attempt returned a 500 that looked like
an application bug and was not.

## Testing

- `verify:all` exit 0: **1314 passed / 321 skipped (1635)**, against 1307 / 321
  (1628) at `a11c670`. 29 boundary probes.
- `NODE_ENV=production npm run build` exit 0.
- Browser walkthrough: 5 themes × (Appearance + dashboard), plus signed-out
  login twice, plus a cascade probe under both OS colour preferences.

## Result

A genuine, user-visible bug that every mathematical check missed: three of five
themes silently did not work on the majority OS setting. Fixed, pinned by a test
that fails on the exact defect.

The Growth palettes render correctly and legibly. Two of the three do not fully
land their stated emotional target on the dashboard, and the reason is the
accent-usage discipline rather than the colours — which is a design question for
its own brief, not a retune.

## Remaining work

1. **The accent discipline question.** `growth-bright` lands on the login page
   and not on the dashboard. Whether the dashboard should spend more accent —
   coloured metric values, a green primary action, a tinted header — is a design
   decision with a sign-off step, deliberately not made here.
2. **Decide the signed-out palette.** Track the default, or pin it.
3. **`NODE_ENV` in `.env.example`**, so `npm run build` works from a clean
   checkout.
4. **`--color-viz-*` per theme**, before Stage 5 ships charts.
5. **Get the e2e suite into a gate.** This bug was invisible to `verify:all` by
   construction; the static guard test helps, but only a browser sees a cascade.
