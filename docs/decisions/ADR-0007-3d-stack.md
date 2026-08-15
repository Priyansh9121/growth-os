# ADR-0007 — three.js with React Three Fiber, no helper library

**Status:** Accepted
**Date:** 2026-08-15

## Context

The login experience is a flagship surface built around a living 3D "Growth
Lattice" ([login-experience.md](../design/login-experience.md)). It must be
premium but not gimmicky, must not harm performance, and must be entirely
optional — the login has to work identically without WebGL, without motion, and
on a low-powered phone.

3D is decorative here. **No information exists only inside the canvas.** That
constraint shapes everything below.

## Decision

- **three.js** as the rendering library.
- **@react-three/fiber** as the React reconciler for it.
- **No `@react-three/drei`** and no other helper library.
- The entire 3D subsystem is **dynamically imported**, behind a capability check,
  and unmounts itself once its purpose is served.

## Alternatives considered

### A — three.js + React Three Fiber, no drei (chosen)

_Why R3F over imperative three.js:_ the scene's lifecycle must be driven by
React state (the login state machine) and must dispose cleanly on unmount. R3F
gives declarative scene composition, automatic disposal of managed objects, and
a render loop that integrates with React — all of which we would otherwise
hand-write and get subtly wrong.

_Why not drei:_ drei is a large grab-bag of helpers. We need perhaps four things
from it, and importing it risks pulling substantially more into a bundle whose
size is the primary risk of this whole feature. The helpers we need (a damped
pointer-parallax rig, an instanced node field, an animated line/points shader)
are around 200 lines of first-party code we fully control.

_Cost:_ we hand-write those helpers and own their correctness, including
disposal.

### B — Imperative three.js without React

_Attractive because:_ smallest possible footprint; no reconciler overhead.

**Rejected because:** the scene must react to the login state machine
(`IDLE → SUBMITTING → CONVERGING → …`) and to route changes. Bridging imperative
scene code to React state by hand is exactly the "animation managed by scattered
booleans" failure the design brief warns against, and disposal correctness
becomes manual.

### C — A 2D `<canvas>` particle/graph animation

_Attractive because:_ far smaller, no WebGL dependency, works everywhere, and
would satisfy a naive reading of the brief.

**Rejected because:** the concept depends on genuine depth — camera push-through
during the transition, parallax, and nodes at different z-depths converging.
Faking perspective in 2D looks like a screensaver. **However**, this is not
wasted analysis: a Canvas2D/CSS composition is exactly what the reduced-motion
and no-WebGL fallback renders.

### D — Spline / Rive / a pre-baked video

_Attractive because:_ designer-friendly authoring, predictable visuals.

**Rejected because:** the scene must be _reactive_ — it responds to focus,
submission, failure and success — which pre-baked assets cannot do. Asset
payloads are also large, and a video cannot participate in the convergence
transition.

### E — GLSL shader-only background (a single full-screen quad)

_Attractive because:_ tiny (no geometry), and very fast.

**Rejected as the primary approach because** the lattice needs discrete,
identifiable nodes labelled with loop stages; a pure fragment shader makes
discrete structure and text anchoring awkward. Shader techniques _are_ used
inside the scene for the signal pulses.

## Performance strategy

The risk with 3D is not that it looks bad — it is that it makes the product feel
slow. Controls adopted:

| Control                   | Implementation                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not in the initial bundle | `next/dynamic` with `ssr: false`; the login form renders and is fully usable before the scene loads                                                  |
| Device pixel ratio capped | `dpr={[1, 1.75]}` — beyond ~1.75 the visual gain is imperceptible and the fill-rate cost is quadratic                                                |
| Draw calls bounded        | Nodes are a single `InstancedMesh`; edges are one `LineSegments`; signals are one `Points`                                                           |
| No textures               | Everything is procedural or vertex-coloured — zero texture bytes and no decode cost                                                                  |
| Frame loop pauses         | `frameloop="demand"` while idle where possible; the loop stops entirely when the tab is hidden                                                       |
| Capability gate           | WebGL support probed before mount; failure renders the static fallback                                                                               |
| Motion preference         | `prefers-reduced-motion: reduce` skips the scene entirely — it is not merely slowed                                                                  |
| Low-power heuristic       | Coarse pointer + narrow viewport, or `navigator.hardwareConcurrency <= 4`, downgrades to the fallback                                                |
| Deterministic disposal    | Geometries, materials and the renderer are disposed on unmount; the canvas unmounts after the transition completes and never mounts on the dashboard |

## Consequences

### Positive

- A distinctive threshold experience that no template ships with.
- Zero 3D cost on the operator surface — the dashboard never mounts a canvas.
- No 3D code in the critical path of authentication.

### Negative

- three.js is a large dependency even lazily loaded; the login route's total
  weight must be tracked against
  [performance-budget.md](../design/performance-budget.md).
- We own the correctness of resource disposal — WebGL context leaks are a real
  failure mode with route changes.
- Two visual paths (3D and fallback) must both be maintained and tested.

### Risks and mitigations

| Risk                                  | Mitigation                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| WebGL context leak across navigations | Explicit disposal on unmount; a test asserts the canvas is removed after the transition completes              |
| Scene janks on low-end mobile         | Capability + heuristic downgrade; DPR cap; instancing                                                          |
| 3D becomes decoration sprawl          | [3d-system.md](../design/3d-system.md) lists where 3D is permitted and explicitly bans it on operator surfaces |

## Revisit when

- The login bundle exceeds its budget → consider a hand-written minimal WebGL
  renderer or move to the Canvas2D composition as the default.
- 3D is proposed anywhere else → that proposal needs its own ADR.

## Related

- [design/3d-system.md](../design/3d-system.md)
- [design/login-experience.md](../design/login-experience.md)
- [ADR-0008](ADR-0008-login-transition-architecture.md)
