# 3D System

**Status:** Implemented (Stage 1 — login only)
**Last reviewed:** 2026-08-15
**Governing ADR:** [ADR-0007](../decisions/ADR-0007-3d-stack.md)

---

## The governing rule

> **3D must carry meaning or identity. It may never be ambient decoration.**

Every 3D element must answer: _what does this communicate that a static image
could not?_ "It looks impressive" is not an answer — it is the reason products
end up with floating cubes that cost 40MB of GPU memory and mean nothing.

---

## Where 3D is permitted

| Surface                     | Permitted   | Purpose                                                                                                               |
| --------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| **Login**                   | ✅ Built    | Product identity + a visual argument for what Growth OS does                                                          |
| Onboarding milestones       | ⬜ Stage 2  | Marking the completion of a setup phase                                                                               |
| High-impact empty states    | ⬜ Stage 4  | The first crawl / first data arriving                                                                                 |
| Selected data visualisation | ⬜ Stage 15 | **Only** where a third dimension carries real information — e.g. an attribution surface over (channel × time × value) |

## Where 3D is banned

| Surface                                       | Why                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Dashboard home and all operator routes        | Opened dozens of times daily. GPU, battery and attention cost with no informational return |
| Any background behind working content         | Competes with the data                                                                     |
| Navigation, menus, controls                   | Interaction latency is more valuable than depth                                            |
| Loading states                                | A 3D loader is slower to first paint than the content it delays                            |
| Marketing-style decoration inside the product | This is the "floating objects everywhere" failure mode                                     |

Adding 3D to a banned surface requires a new ADR.

---

## The Growth Lattice (login)

### Concept

A spatial directed graph of the growth loop. Nodes are stages; edges are the
causal paths between them; luminous pulses are signals travelling the loop.

```
     SEARCH ──▶ SITE ──▶ LEAD ──▶ AI ──▶ BOOKING ──▶ REVENUE
        ▲                                                │
        └────────────────── OPTIMISE ◀───────────────────┘
```

**Why this and not an abstract particle field:** it is a literal diagram of the
product's thesis. Someone who has never heard of Growth OS should be able to
infer from the login screen that this system connects being found to making
money. It is an argument, not wallpaper.

### Composition

- **7 stage nodes** on a shallow, roughly elliptical path in 3D, at varying
  depth so parallax and camera motion read as real space.
- **A closed edge loop** connecting them in causal order.
- **Signal pulses** travelling edges continuously — the "living" quality. Their
  density is deliberately low; this is instrumentation, not a fireworks display.
- **A sparse depth field** of small points far behind, purely to give the camera
  push something to travel _through_.

### Materials and palette

No textures, no lighting rig, no shadows. Everything is emissive or vertex
coloured, using the palette read from the design tokens at runtime — the scene
cannot drift from the design system because it does not own any colours.

Nodes and edges sit at low luminance at rest; only the signal pulses reach full
accent brightness. The scene should look like it is _at rest and working_, not
performing.

### Interaction

| Input        | Response                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Pointer move | Camera parallax, ±2.5° max, critically damped (~0.08 lerp). Subtle enough that most users will not consciously notice it |
| Field focus  | Nothing. **The scene never reacts to typing** — a moving background while entering a password is hostile                 |
| Submit       | Signal pulse rate increases slightly; the lattice "leans in"                                                             |
| Auth failure | Pulses settle back to rest over 400ms. No red flash, no shake                                                            |
| Auth success | **Convergence** — see below                                                                                              |

### Convergence (the transition)

On successful authentication, over ~720ms:

1. Edges contract toward the lattice centroid.
2. Nodes converge and collapse into the geometry of the Growth OS mark.
3. The camera pushes forward through the collapsing structure.
4. The scene fades as the dashboard shell resolves behind it.
5. `COMPLETE` — the canvas unmounts and the WebGL context is released.

The camera push is what makes this read as _entering_ rather than _watching_.

Full specification in [login-experience.md](login-experience.md); the
architecture is [ADR-0008](../decisions/ADR-0008-login-transition-architecture.md).

---

## Non-negotiable constraints

### 1. 3D is never required to use the product

The login form is fully functional and complete before the scene loads, and
identical when it never loads. The canvas is `aria-hidden`, behind
`pointer-events: none`, and outside the tab order.

**No information exists only inside WebGL.** The stage labels rendered in the
scene are decorative; nothing depends on reading them.

### 2. Four independent downgrade paths

Evaluated in order; the first match wins:

| Condition                                   | Result                                           |
| ------------------------------------------- | ------------------------------------------------ |
| `prefers-reduced-motion: reduce`            | Static composition. The scene is **not mounted** |
| WebGL unavailable or context creation fails | Static composition                               |
| Coarse pointer + viewport < 768px           | Static composition (mobile)                      |
| `navigator.hardwareConcurrency <= 4`        | Static composition                               |
| Otherwise                                   | Full 3D lattice                                  |

The static composition is a CSS/SVG rendering of the same lattice — same
concept, same palette, no GPU cost. **It is designed to be good**, not to be an
apology. The majority of mobile users will only ever see this, and it must feel
premium on its own terms.

### 3. Performance envelope

| Constraint                | Value                        | Why                                                                                                   |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Not in the initial bundle | `next/dynamic`, `ssr: false` | Authentication must not wait on 3D                                                                    |
| Device pixel ratio        | capped at 1.75               | Fill-rate cost is quadratic; visual gain above this is imperceptible                                  |
| Draw calls                | ≤ 5                          | One instanced mesh (nodes), one line segments (edges), one points (signals), one points (depth field) |
| Triangles                 | < 10,000                     | Nodes are low-poly icosahedra; there is no detailed geometry                                          |
| Textures                  | **zero**                     | No decode cost, no memory, no network                                                                 |
| Frame loop                | pauses on `visibilitychange` | No battery drain in a background tab                                                                  |
| Disposal                  | explicit on unmount          | Geometries, materials, renderer. WebGL contexts are a finite browser resource                         |

### 4. Disposal is mandatory

Every geometry, material and renderer created must be disposed. A leaked WebGL
context across repeated navigations eventually causes the browser to drop the
oldest context, and the symptom (a blank canvas, much later, on an unrelated
page) is extremely hard to diagnose.

The canvas unmounts at `COMPLETE`, and a test asserts it is gone.

---

## Review checklist for any future 3D work

- [ ] What does this communicate that a static image could not?
- [ ] Is it on a surface where 3D is permitted?
- [ ] Is it fully optional, with a designed (not degraded) fallback?
- [ ] Does it respect `prefers-reduced-motion` by **not mounting**?
- [ ] Draw calls, triangles, textures within envelope?
- [ ] Are all resources disposed on unmount?
- [ ] Does the frame loop pause when hidden?
- [ ] Is it excluded from the initial bundle?
- [ ] Is it `aria-hidden` and outside the tab order?
- [ ] Has the login route's bundle been re-measured against
      [performance-budget.md](performance-budget.md)?
