# ADR-0059 — The signed-out surface is pinned, not inherited

**Status:** Accepted
**Scope:** Narrows [ADR-0056](ADR-0056-user-theme-preference.md) Decision 3
(server-side resolution) for unauthenticated requests only. ADR-0056's other
decisions and [ADR-0057](ADR-0057-growth-theme-palettes.md) are unchanged.
**Date:** 2026-08-21

## Context

`resolveRequestTheme()` returned `DEFAULT_THEME_PREFERENCE` for every request
without a valid session. That constant answers a different question — _"what
theme does a newly created ACCOUNT start with?"_ — and the signed-out surface
was reading it only because it happened to be the nearest available default.

Nobody decided that. It was an inheritance, not a choice, and dev log 0040
flagged it as an open product question rather than a bug (0040 §"The brief's
premise about the login page was wrong"); dev log 0045 carried it forward as
remaining work item 1.

The consequence is specific and silent: a future session changing the default
theme for new accounts — exactly what ADR-0057 did once already, moving it from
`dark` to `growth-bright` — would also restyle the login page, with nothing in
the diff, the tests or the review saying so.

## ⚠️ Re-measured first, and the received description was wrong

Verified in this session rather than carried from the dev logs:

- `DEFAULT_THEME_PREFERENCE` is **`growth-bright`**
  (`packages/contracts/src/auth/theme.ts`).
- `resolveRequestTheme()` returned it at three points — no cookie, invalid
  session, and any thrown error (`apps/web/src/server/theme.ts`).
- The value reaches `<html data-theme>` in the root layout, in the first bytes
  of the response.

The task brief proposed pinning to Dark _"since that's the current de facto
behavior."_ **That is false.** The de facto signed-out theme has been
`growth-bright` since ADR-0057. The brief re-imported the same stale premise
dev log 0040 had already retired. Pinning to Dark would have been a visible
regression of the login page carried out in the belief that it changed nothing.

## Decision — an explicit `SIGNED_OUT_THEME` constant

The signed-out surface renders `SIGNED_OUT_THEME`, a constant that exists for
that purpose alone and is independent of `DEFAULT_THEME_PREFERENCE`.

Its value is **`growth-bright`** — identical to today's rendered result, so this
change is deliberately a no-op on screen. The point is not the pixels; it is
that the two values are now separately owned. A future change to either one
cannot move the other by accident.

### Why pin rather than track

Both were defensible and the alternative was put explicitly. Pinning won on
these grounds:

1. **The two questions have different owners.** The account default is a
   product decision about people who already bought. The signed-out palette is
   the first thing a prospective user sees. Coupling them means the second is
   always decided as a side effect of the first.
2. **`growth-bright` earns the slot on evidence.** Dev log 0040's browser
   walkthrough found the accent discipline underspends the palette on the
   dashboard, but recorded the opposite for this surface: _"On the login page:
   yes. Big green CTA, green lattice, spring-green canvas — that screen
   genuinely lands the intent."_ The palette is at its strongest exactly here.
3. **A pin fails loudly; tracking fails silently.** Under tracking, the
   safeguard is a comment and a test asking a future session to think. Under a
   pin there is nothing to think about: changing the account default cannot
   reach this surface at all.

The cost is accepted: two constants can drift apart. That is the feature.

## Decision — the pin is keyed on the SESSION, and its edge is stated

`resolveRequestTheme()` has no access to the pathname. Every theme selector in
`tokens.css` is `:root`-scoped, so only `<html>` — set by the single root
layout, which ADR-0008 requires to be shared by `/login` and `/dashboard`
alike — can carry a palette. Route-aware theming would therefore need either a
`middleware.ts` (none exists) or a second copy of all five palettes under a
non-`:root` selector.

Both were rejected as far out of proportion to a colour, so the pin applies to
**requests with no valid session**, which is what the root layout can actually
observe.

Measured consequence, stated rather than discovered later: `/forgot-password`
and `/reset-password` do not redirect an authenticated visitor the way
`/login` does, so a signed-in user who opens one of them still sees their own
saved theme. That is a narrow, deliberate edge, not an oversight — see dev log
0046 for the browser measurement that established it.

## Consequences

- `SIGNED_OUT_THEME` is exported from `@growth-os/contracts` beside the
  vocabulary it draws from, so there is still exactly one list of valid themes.
- A unit test asserts the literal value, not `SIGNED_OUT_THEME` compared to
  itself. Asserting the constant against itself would pass no matter what the
  constant became, which is the failure mode `packages/auth`'s preference tests
  already call out.
- A test asserts the two constants are **independently** declared, so a later
  edit aliasing one to the other reintroduces the coupling loudly.
- No visual change. The login page rendered `growth-bright` before this and
  renders `growth-bright` after it.
