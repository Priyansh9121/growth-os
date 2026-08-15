# ADR-0008 — Persistent scene host driven by an explicit state machine

**Status:** Accepted
**Date:** 2026-08-15

## Context

The login → dashboard transition is a signature experience: the growth lattice
should converge, the camera push forward, and the dashboard emerge from the same
continuous surface — rather than login, white flash, dashboard.

This is hard for reasons that are architectural, not artistic:

1. A route change in Next.js unmounts the previous route's component tree. A
   canvas that unmounts cannot animate across the transition, and remounting
   WebGL mid-transition guarantees a visible break.
2. **Authentication latency and animation duration are independent.** Auth may
   resolve in 80 ms or 4 s. Neither may be padded to suit the other.
3. The sequence must degrade correctly for: reduced motion, no WebGL, mobile,
   auth failure, slow dashboard data, and — importantly — an authenticated
   refresh of `/dashboard`, which must **not** replay the entrance.
4. Animation must never be load-bearing for routing. If any animation code
   throws, the user must still arrive, authenticated, at the dashboard.

## Decision

### 1. The scene host lives in the root layout

`<GrowthFieldHost />` is rendered by the **root** layout as a fixed-position
background layer, not by the `(auth)` route group. Route groups have separate
layouts and would unmount it. Because the root layout persists across the
`/login → /dashboard` navigation, the WebGL context survives the route change.

The host is not always a canvas: it decides per state whether to render the 3D
scene, the static fallback, or nothing at all. **Once the transition completes,
it renders nothing and the WebGL context is released** — the dashboard pays no
ongoing 3D cost, and a direct load of `/dashboard` never creates a context.

### 2. An explicit finite state machine

Transition state is a single discriminated union in
[`apps/web/src/features/auth-transition/machine.ts`](../../apps/web/src/features/auth-transition/machine.ts),
reduced by pure functions and exposed through one context:

```
                    ┌──────────────── AUTH_FAILED ◀──┐
                    ▼                                │
IDLE ──SUBMIT──▶ SUBMITTING ──success──▶ AUTHENTICATED
                    │                          │
                    └──────────────────────────┘
                                               ▼
                                        TRANSITION_PREP   (scene snapshots pose)
                                               ▼
                                        TRANSITIONING     (converge + camera push;
                                               │           router.push in parallel)
                                               ▼
                                        DASHBOARD_ENTER   (shell choreography)
                                               ▼
                                          COMPLETE        (scene disposes)
```

Pure reducer, no `setTimeout` chains, no booleans spread across components. The
scene, the login card and the dashboard shell are all _readers_ of this one
state.

### 3. Navigation is never gated on animation

On a successful authentication response the machine advances **and**
`router.push()` is called. The animation observes the state; it does not control
the route. Concretely:

- Auth resolves fast → the transition plays at its natural pace.
- Auth resolves slowly → the card holds a "verifying" state; the scene continues
  its idle motion. Nothing is faked and no artificial delay is inserted.
- Auth fails → the machine returns to `IDLE` via `AUTH_FAILED`; the scene
  relaxes back to idle; focus returns to the form with the error announced.
- **Animation throws** → the machine still reaches `COMPLETE`; navigation has
  already happened.

The maximum time the visual layer may hold is bounded by a watchdog; on expiry
it jumps straight to `COMPLETE`.

### 4. Entrance replay is decided by initial state, not by storage

The provider initialises to `COMPLETE` when the app mounts on an application
route, and to `IDLE` on the login route. Because the machine lives in React
memory, a refresh of `/dashboard` naturally initialises to `COMPLETE` — the
entrance sequence cannot replay, with no flag to write, read, expire or leak.

Only a genuine `SUBMIT → AUTHENTICATED` sequence within one page lifetime
reaches `DASHBOARD_ENTER`.

## Alternatives considered

### A — View Transitions API

_Attractive because:_ purpose-built for cross-document/route continuity, and
browser-native.

**Rejected because:** it animates snapshots of DOM state. It cannot express "a
WebGL camera pushes through a converging graph while the shell resolves behind
it", and cross-document support is still uneven. Worth revisiting for
_intra-dashboard_ route transitions, where it fits well.

### B — Render the dashboard inside the login page and never navigate

_Attractive because:_ trivially continuous — no unmount at all.

**Rejected because:** the URL would lie, refresh and deep links would break,
back/forward would misbehave, and it couples two unrelated surfaces. Correct
routing is not negotiable for animation.

### C — Full-screen overlay that covers the route change

_Attractive because:_ simple and robust; the standard approach.

**Rejected as the primary mechanism because** it is a curtain, not a transition —
the thing the brief explicitly rejects. It _is_, however, exactly what the
reduced-motion path does: a short, calm cross-fade.

### D — `sessionStorage` flag to decide whether to replay the entrance

**Rejected because:** it introduces persistent state that can desynchronise
(stale flag → animation replays on refresh; cleared flag → no animation after
login), plus a cleanup burden. Initial-state derivation gets the same result
with no storage.

### E — `setTimeout` choreography

**Rejected because:** timers cannot be paused, cancelled or resumed coherently
when auth resolves at an unpredictable time, and the resulting code is
untestable. The machine is a pure reducer with unit tests over its transitions.

## Consequences

### Positive

- A genuinely continuous transition, with correct URLs and history.
- Authentication timing and animation timing are fully decoupled.
- The transition is unit-testable without a browser — the reducer is pure.
- Zero 3D cost on the operator surface and on authenticated refresh.
- Animation failure cannot strand a user outside the application.

### Negative

- The scene host in the root layout is a small piece of global architecture that
  every future route inherits. Mitigated by it rendering `null` in `COMPLETE`.
- Two visual paths (full and reduced) to maintain and test.
- Requires care that the scene is not re-created by React Strict Mode double
  mounting in development.

### Risks and mitigations

| Risk                                                  | Mitigation                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A stuck state leaves the user staring at an animation | Watchdog timeout forces `COMPLETE`; navigation already happened independently        |
| WebGL context not released after transition           | Host renders `null` at `COMPLETE`; explicit disposal; asserted by test               |
| Dashboard data slower than the transition             | Shell renders with skeletons; `DASHBOARD_ENTER` choreographs the shell, not the data |

## Revisit when

- View Transitions gain the fidelity to express this, or are wanted for
  intra-dashboard navigation.
- Analytics show users repeatedly waiting on the transition — reduce durations
  before adding complexity.

## Related

- [design/login-experience.md](../design/login-experience.md)
- [design/motion-system.md](../design/motion-system.md)
- [ADR-0007](ADR-0007-3d-stack.md)
