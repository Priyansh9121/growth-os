# 0004 — Design system, 3D login and the transition

**Date:** 2026-08-15 · **Stage:** 1

## Objective

Build the design system, the flagship login, and a continuous login → dashboard
transition that does not compromise routing, accessibility or performance.

## Initial state

Authentication and tenancy complete ([0003](0003-authentication-and-tenancy.md)).
No UI.

## Investigation

**The transition is an architecture problem, not an animation problem.** Three
constraints conflict:

1. A Next.js route change unmounts the previous tree. A canvas that unmounts
   cannot animate across the transition.
2. Authentication latency (80 ms or 4 s) and animation duration are
   independent. Neither may be padded to suit the other.
3. An authenticated refresh of `/dashboard` must **not** replay the entrance.

The resolution came from noticing that the **root layout persists across the
navigation**, while route-group layouts do not. Hosting the scene and the state
machine there makes continuity possible without faking anything.

The replay problem then solved itself: derive the machine's initial phase from
the route the app **booted on**. Boot on `/login` → `idle`; boot anywhere else →
`complete`. A refresh of `/dashboard` initialises at `complete`, so the
entrance cannot replay — with no `sessionStorage` flag to desynchronise, expire
or clean up.

## Decisions

1. **Scene host + state machine in the ROOT layout**
   ([ADR-0008](../decisions/ADR-0008-login-transition-architecture.md)).
2. **Navigation is never gated on animation.** `router.push()` fires in
   parallel with `AUTH_SUCCEEDED`. If every line of scene code threw, the user
   would still arrive, authenticated.
3. **A pure reducer over a discriminated union**, not booleans and
   `setTimeout` chains. This is what makes the whole choreography — including
   its failure modes — testable in milliseconds without a browser.
4. **`FORCE_COMPLETE` is reachable from every phase**, backed by a 2.6 s
   watchdog. An animation bug must never trap a user.
5. **The host renders `null` at `complete`**, releasing the WebGL context. The
   dashboard pays no 3D cost, ever, and a direct authenticated load never
   creates a context.
6. **Design tokens live in CSS, not TypeScript** — because the WebGL scene
   reads its palette via `getComputedStyle`. The scene therefore cannot drift
   from the design system, since it owns no colours.
7. **three.js without drei.** The four helpers we needed are ~200 lines of
   first-party code; drei would have risked the bundle, which is the main risk
   of this feature.

## Alternatives considered

- **View Transitions API** — animates DOM snapshots; cannot express a WebGL
  camera pushing through a converging graph. Worth revisiting for
  intra-dashboard navigation.
- **Render the dashboard inside the login and never navigate** — trivially
  continuous, but the URL would lie and back/forward would break. Correct
  routing is not negotiable for animation.
- **Full-screen overlay** — a curtain, not a transition. It _is_ what the
  reduced-motion path does.
- **`sessionStorage` flag for replay** — stale flag means the animation
  replays; cleared flag means it never plays. Initial-state derivation gets the
  same result with no persistent state.

## Files created

`packages/ui/src/tokens/tokens.css` (the single source of truth) · motion
tokens · `useReducedMotion` · eight primitives · the Growth mark.
`apps/web/src/features/auth-transition/` (machine + provider) ·
`features/growth-field/` (geometry, R3F scene, capability detection, static
fallback, host) · `features/login/` · shell and dashboard components · route
handlers · navigation manifest · fixtures.

## Architecture impact

Two pieces of genuinely global architecture in the root layout, both of which
render nothing once the transition completes.

The **navigation manifest** is a small but load-bearing idea: one declarative
description of the product surface drives both the sidebar and a single
catch-all placeholder route. Every navigation link works, no dead links exist,
and ~20 routes are served by one 60-line file that cannot drift from the menu.

## Security impact

No new surface. Two properties preserved deliberately: the login form is fully
functional before and without the 3D scene, and **no information exists only
inside WebGL** (the canvas is `aria-hidden`, `pointer-events: none`, outside
the tab order).

## Testing

The contrast test — which computes real WCAG ratios from the token values —
**caught two genuine light-theme failures**: the signal accent at 4.29:1 and
attention at 4.44:1 against a 4.5:1 requirement. Both were invisible by eye and
both were fixed by darkening the tokens.

This is exactly why the ratios are computed rather than asserted in prose.

Also: 22 machine tests covering every phase/event pair, illegal transitions,
reduced flow and watchdog reachability; 11 component tests covering labelling,
tab order, ARIA state, error announcement and focus return.

## Result

A login with a living 3D growth lattice that converges into the product mark
while the camera pushes through it, four independent fallback paths, and a
transition that cannot strand a user.

## Remaining work

No physical-device testing. No visual regression suite — deferred until the
design system stabilises, because screenshot tests on a moving design are noise.
