# Performance Budget

**Status:** Baseline measured (Stage 1)
**Last measured:** 2026-08-15

Every number below was produced by a command that is written down. Nothing here
is estimated, and figures that have **not** been measured say so explicitly
rather than being guessed at.

---

## Measured baseline

**Command:**

```bash
cd apps/web && npx next build          # Next.js 16.3.1, Turbopack, production
npx next start --port 3111
curl -s http://localhost:3111/login    # then sum the gzipped size of every
                                       # chunk the returned HTML references
```

Gzip level 6, matching typical CDN defaults. Full method:
`docs/development-log/0005-verification-and-measurement.md`.

| Metric                                | Measured                                                  | Budget              | Status     |
| ------------------------------------- | --------------------------------------------------------- | ------------------- | ---------- |
| **Login — initial JS**                | **252.5 KB gzip** (12 chunks)                             | 250 KB              | ⚠️ 1% over |
| **Dashboard — initial JS**            | **260.8 KB gzip** (13 chunks)                             | 250 KB              | ⚠️ 4% over |
| **3D lattice chunk**                  | **228.9 KB gzip** (868.8 KB raw)                          | 260 KB              | ✅         |
| **three.js in initial bundle**        | **No**                                                    | Must be no          | ✅         |
| **three.js on the dashboard**         | **No**                                                    | Must be no          | ✅         |
| Login HTML document                   | 44.1 KB raw / 6.4 KB gzip                                 | 60 KB raw           | ✅         |
| Total client JS emitted               | 495.1 KB gzip across 16 chunks                            | —                   | —          |
| Font payload                          | 0 bytes network (Geist is self-hosted and subset by Next) | 0 external requests | ✅         |
| Texture/image payload in the 3D scene | 0 bytes                                                   | 0                   | ✅         |

### Reading these honestly

**The two most important results are the negatives.** three.js — the single
largest asset in the product at 229 KB gzip — is absent from both the login's
and the dashboard's initial bundles. The lazy-loading architecture
([ADR-0007](../decisions/ADR-0007-3d-stack.md)) works: authentication never
waits on 3D, and the operator surface pays nothing for it, ever.

**The initial-bundle budget is marginally exceeded on both routes**, by 1% and
4%. This is React 19 plus the Next.js App Router runtime, not application code —
our own code is a small fraction of it. It is recorded as a real overage rather
than adjusted away, and the reduction paths are listed below.

---

## Not yet measured

Stated plainly rather than filled in with plausible numbers.

| Metric                       | Target                               | Why not measured                                                        |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| LCP (login, mobile 4G)       | < 2.0 s                              | Needs Lighthouse against a deployed origin with real network throttling |
| LCP (dashboard)              | < 1.5 s                              | As above                                                                |
| CLS                          | < 0.05                               | Requires field or lab measurement                                       |
| INP                          | < 200 ms                             | Requires interaction tracing                                            |
| TTFB                         | < 300 ms                             | Depends on hosting, not yet chosen                                      |
| 3D frame rate                | ≥ 55 fps mid-range, ≥ 30 fps low-end | Requires physical devices; the emulator's numbers would be fiction      |
| WebGL memory                 | < 60 MB                              | Requires a device profiler                                              |
| Route transition (dashboard) | < 300 ms                             | Requires deployed instrumentation                                       |

**These will be measured before public launch, not before.** Quoting a
Lighthouse score from a local machine over loopback would be worse than
admitting the gap — it would look like evidence.

---

## Budgets

### Initial JavaScript

| Route                       | Budget      | Rationale                                                                    |
| --------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `/login`                    | 250 KB gzip | A threshold surface. The form must be interactive before 3D exists           |
| `/dashboard` and app routes | 250 KB gzip | Opened dozens of times a day; this is the number that matters most long-term |
| Lazy 3D chunk               | 260 KB gzip | Loads after the form is usable and never blocks input                        |

### 3D scene envelope

Enforced by construction in
[`lattice-scene.tsx`](../../apps/web/src/features/growth-field/lattice-scene.tsx),
not by measurement:

| Constraint                 | Design value                                                 |
| -------------------------- | ------------------------------------------------------------ |
| Draw calls                 | 4 (instanced nodes, edge lines, signal points, depth points) |
| Triangles                  | ~140 (7 detail-0 icosahedra) plus points                     |
| Textures                   | 0                                                            |
| Device pixel ratio         | capped at 1.75                                               |
| Frame loop when tab hidden | stopped (`visibilitychange`)                                 |
| Resource disposal          | explicit on unmount                                          |

### Motion

60 fps target, 16.7 ms frame budget. Only `transform` and `opacity` are
animated — anything else forces layout or paint per frame. No more than ~12
elements animate at once. `will-change` is applied before an animation and
removed after; a permanent `will-change` permanently holds a compositor layer.

---

## Reduction paths, in order of value

Not yet applied — recorded so the overage has a plan rather than a shrug.

1. **Audit the `motion` import surface.** It is used for a handful of
   transitions; a tree-shaking review or replacing them with CSS transitions is
   the cheapest available win.
2. **Route-level code splitting for the dashboard shell.** The workspace
   switcher and account menu are interactive but not needed for first paint.
3. **React Server Components discipline.** Every component that does not need
   interactivity should stay server-side. The current split has not been
   audited.
4. **Re-measure after each change.** A reduction that is not re-measured has
   not happened.

---

## Regression protection

**Currently: none automated.** This is a known gap.

Planned, in order:

1. A CI step that fails when the login route's initial JS exceeds its budget —
   the same measurement script used here, run on every pull request.
2. Lighthouse CI against a preview deployment once hosting exists.
3. Real-user monitoring for field LCP/INP/CLS after launch.

Until step 1 lands, re-measure manually before any change that touches
dependencies or the 3D scene, and update the table above with the new numbers
and the date.

---

## The rule

> **Do not make a performance claim without the command that produced it.**

A number without a method is marketing. If a figure in this document cannot be
reproduced by running the command beside it, the figure is a bug.
