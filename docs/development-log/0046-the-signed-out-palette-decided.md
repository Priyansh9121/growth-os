# 0046 — The signed-out palette, decided — and a `.check()` that could never pass

**Date:** 2026-08-21 · **Stage:** 4

## Objective

Close remaining-work item 1 from [0045](0045-a-preflight-that-lied.md), open
since [0040](0040-opening-a-browser.md): decide whether the signed-out surface
tracks the product's default theme or is pinned to one, and implement the
answer. A product decision, so it was put before it was built.

This entry covers two sessions. The first made the decision and built it, then
hit its usage limit with three browser tests failing and the cause undiagnosed.
The second diagnosed them. The second half of this log is that diagnosis, and it
is the more useful half.

## Initial state

Verified, not recalled. First session: `2d98636`, tree clean, no divergence from
origin, `npm test` exit 0 at **1388 passed / 321 skipped (1709)**.

Second session: `a935ab2`, `ahead 1`, the slice-2 files uncommitted as described,
`npm test` exit 0 at **1403 passed / 321 skipped (1724)**.

The 321 skips are the `integration` project self-skipping with
`TEST_DATABASE_URL` unset in the shell; that is the documented design in
`vitest.config.ts`, not a failure.

## Re-measured before deciding, and the brief was wrong again

§1 says re-verify rather than inherit a description, and it earned its keep. The
brief proposed pinning to Dark _"since that's the current de facto behavior."_
Measured:

```
packages/contracts/src/auth/theme.ts:60
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'growth-bright';
```

**The de facto signed-out theme is `growth-bright`, and has been since
ADR-0057.** Pinning to Dark would have been a visible regression of the login
page, carried out in the belief that it changed nothing.

This is the _second_ time this premise has been wrong in a brief.
[0040](0040-opening-a-browser.md) recorded the identical correction — the brief
there asked to _"confirm the login page always renders Dark"_ — and the
correction did not survive into this one.

The actual path, read rather than assumed: `layout.tsx:69` calls
`resolveRequestTheme()`, which returned `DEFAULT_THEME_PREFERENCE` at three
points — no cookie, invalid session, and any throw.

## The decision, and why it needed a constant rather than a comment

Pinned, not tracking — [ADR-0059](../decisions/ADR-0059-signed-out-theme-is-pinned.md).
The signed-out surface greets people with no account; the account default is a
property of accounts. Coupling them means a future change to one silently moves
the other.

⚠️ **`SIGNED_OUT_THEME` and `DEFAULT_THEME_PREFERENCE` hold the same string
today, which is exactly what makes this dangerous to test.** Every naive
assertion passes whether the resolver reads the right constant or the wrong one.
So `apps/web/src/server/theme.test.ts` mocks `@growth-os/contracts` so the two
constants **disagree** (`growth-warm` vs `dark`), which turns "which one does
this module actually read" into a question with a visible answer. Reverting
`theme.ts` to the old constant turns it red; without the disagreeing mocks it
would stay green.

The pin is keyed on the **session**, not the route, and the ADR now records why
on evidence rather than on effort: Next.js's own documentation for 16.3.1 says
layouts _"do not re-render on navigation, so they do not access pathname which
would otherwise become stale"_. A route-derived theme in the root layout would
be correct on first paint and wrong immediately after.

## ⚠️ The three failing browser tests: `.check()` was asserting something the component cannot do

The first session left `verify:e2e` with three failures, all identical:

```
Error: locator.check: Clicking the checkbox did not change its state
  - locator resolved to <input type="radio" value="growth-warm" ...>
  - element is visible, enabled and stable
  - click action done
```

The locator resolved to the **correct** element every time, so this was never
selector ambiguity. Three candidate causes were on the table — already-checked,
a `startTransition` re-render race, or Playwright's actionability disagreeing
with a custom `checked` prop. §1 says a measurement decides, so a throwaway
probe read every radio's live DOM properties at each instant around the click,
against the production build:

| instant                     | `growth-bright` | `growth-warm`   | group        |
| --------------------------- | --------------- | --------------- | ------------ |
| before click                | `checked: true` | `checked:false` | enabled      |
| **immediately after click** | `checked: true` | `checked:false` | **disabled** |
| after the PATCH returns 200 | `checked:false` | `checked: true` | enabled      |

**The click always worked. The assertion looked too early — every time.**

`ThemeSetting` renders a controlled radio, `checked={theme === option}`, and
raises `setTheme` inside `startTransition`. That makes the theme change the
**low-priority** update; the urgent one is `pending`, which is why the whole
group reads `disabled: true` one tick after the click — proof the `onChange`
handler did run. While React renders that pending UI from the _old_ state it
reverts the radio's native `checked`. Playwright's `.check()` clicks and then
asserts `checked` in the same breath, so its post-condition is false at the only
instant it ever inspects.

⚠️ **It was failing 100% of the time, not intermittently.** This was not a flake
and "add a wait" would have been a blind fix for a misdiagnosed problem. It also
was **not a product defect**: the final state was correct in every one of those
runs, `data-theme` repaints optimistically and immediately, and
`theme-setting.test.tsx` has always passed because it uses `waitFor` rather than
asserting synchronously. No production code was touched.

The fix is the pattern §6 already requires and `lifecycle.spec.ts`'s
`fieldSaved` already established — wait on an observable signal, never a sleep:
click, await the PATCH response, then assert with a **retrying**
`toBeChecked()`. The helper also short-circuits when the target radio is already
selected, because clicking an already-selected radio fires no `change` event, so
no PATCH would ever arrive and the wait would hang for the full timeout.

## ⚠️ The inherited slice was passing tests, not passing the gate

The brief described the uncommitted slice-2 files as "all passing and
mutation-tested". `npm test` agreed. `npm run lint` did not:

```
apps/web/src/server/theme.test.ts
  29:35  error  `import()` type annotations are forbidden
         @typescript-eslint/consistent-type-imports
```

A green test run is not the repository's gate — `verify:all` is, which is the
whole argument of §7's note on why the Definition of Done defers to the
repository instead of listing checks. The file had never been through it.
Corrected to a named type import in the same commit; nothing about the test's
behaviour changed.

Worth recording because it is a small instance of a general failure: a dying
session reports the check it ran, and the next session inherits that report as
though it were the check it should have run.

## ⚠️ A second correction: the brief's arithmetic

The brief expected **74** tests — "the 71 existing + 3 new". The new spec
contains **six** tests, not three; three of them touch the theme picker and were
the three that failed, which is where the undercount came from. Observed:
**77 passed**.

## ⚠️ And a third: the preflight caught me the way it was designed to

The first probe run was made with `npx playwright test` directly, which
bypasses `verify:e2e`'s preflight. It died inside `globalSetup` with
`password authentication failed for user "growth_os"` — because with no
`TEST_DATABASE_URL` exported, `e2eDatabaseUrl()` falls back to the documented
docker-compose literal on port `5432`, and this machine's system PostgreSQL is
listening there.

That is [0045](0045-a-preflight-that-lied.md)'s scenario reproduced by accident,
and it is worth recording that I walked into it: `pg_isready` on `5432` answered
"accepting connections", and I reported Postgres as up before checking _which_
cluster. The project's is on `55432`. 0045's whole point is that a TCP-level
answer about the wrong cluster is worse than no answer, and it caught a live
agent doing exactly that within an hour of being written.

## Testing

- `npm test` exit 0: **1403 passed / 321 skipped (1724)**, against 1388 / 321
  (1709) at `2d98636`.
- `verify:all` exit 0: **1403 passed / 321 skipped (1724)**, 29 boundary probes.
- `verify:e2e` exit 0: **77 passed**, against 71 at `b18937b`. The six new tests
  assert both sides of the boundary — the logged-out surface ignores a saved
  `growth-warm`, and the logged-in surface still honours it on `/dashboard`,
  `/system/appearance` and `/customers/contacts`.
- One test asserts the palette is in the **served HTML**, not applied by script,
  which a DOM assertion alone cannot distinguish.
- Each slice verified independently green by checking it out and measuring, not
  inferred from the tip (§4): `a935ab2` at 1395 / 321 (1716) and 71 e2e;
  `a62e0b2` at 1403 / 321 (1724) and 71 e2e; the tip at 1403 / 321 (1724) and
  77 e2e.

## What is unverified

**No visual check was made that `growth-bright` still renders correctly.** It
did not change and the e2e suite reads `data-theme`, not colour — §7 is explicit
that the browser gate does not cover themes or contrast. Nothing here alters a
palette, so this is stated as a limit rather than as a risk.

**The stated edge is asserted, not closed.** A signed-in visitor who opens
`/forgot-password` or `/reset-password` still sees their own theme. The e2e spec
asserts that behaviour outright, so a future session choosing to close it has to
change a test that says so — rather than discovering it in a browser.

**The radio's selection lags the save by one round-trip**, and the group is
disabled meanwhile. That is the component's existing design, unchanged here, and
it is what the diagnosis above turned up. Whether the picker should advance
`checked` optimistically the way `data-theme` already does is a real question
and is **out of scope for this task**, deliberately not answered.

## Result

Remaining-work item 1 from 0040 and 0045 is closed. The signed-out palette is a
decision with a constant, a unit test that can actually fail, and a browser test
that proves it end to end.

## Remaining work

1. **`growth-warm`'s accent/attention separation** — amber-on-amber at 27°
   ([0041](0041-spending-the-accent.md)).
2. **`--color-viz-*` per theme**, before Stage 5 ships charts. Still latent.
3. **Optimistic `checked` in `ThemeSetting`** — new, and small. The picker's
   selection dot waits for the server while the palette does not.

⚠️ **Migrations, measured not carried:** disk **14**, test DB **14**. None added.
