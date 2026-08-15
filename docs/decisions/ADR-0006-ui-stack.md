# ADR-0006 — Next.js App Router, Tailwind v4, first-party primitives

**Status:** Accepted
**Date:** 2026-08-15

## Context

Growth OS has two very different UI surfaces: a **threshold** surface (login)
that must be visually exceptional, and an **operator** surface (dashboard) opened
dozens of times a day that must be fast and dense. It must not look like a
generic admin template, and it must be accessible.

## Decision

- **Next.js 16 (App Router)** with React 19 Server Components.
- **Tailwind CSS v4** with a CSS-first `@theme` token layer in
  [`packages/ui/src/tokens/tokens.css`](../../packages/ui/src/tokens/tokens.css).
- **First-party primitives** in `@growth-os/ui`, not a component library.
- **`motion`** (Framer Motion's successor package) for application motion.
- **Geist Sans / Geist Mono**, self-hosted via the `geist` npm package.

## Alternatives considered

### Framework

#### A — Next.js App Router (chosen)

_Why:_ Server Components let the dashboard fetch tenant-scoped data on the
server with no client-side data layer, no token in the browser, and no
loading-waterfall boilerplate. Streaming suits a dashboard of independent
panels. Nested layouts give a persistent shell — and, critically, a persistent
**root layout**, which is what makes the continuous login → dashboard transition
possible ([ADR-0008](ADR-0008-login-transition-architecture.md)).

_Cost:_ framework coupling, and a genuinely subtle server/client boundary.
Mitigated by keeping business logic in framework-free packages — route handlers
and server components are adapters only.

#### B — Vite + React SPA with a separate API

_Attractive because:_ clean client/server split; the API host would exist from
day one.

**Rejected because:** it forces an immediate answer to token storage in the
browser — and the good answers converge back on `httpOnly` cookies and a
server. It also loses server-side rendering of tenant-scoped data, and the
persistent-shell trick that makes the login transition work.

#### C — Remix / React Router 7

**Rejected because:** capable and a close call, but a smaller ecosystem for the
specific things we need next (streaming dashboards, partial prerendering), and
no advantage that offsets the switch.

### Styling

#### D — Tailwind v4 (chosen)

_Why:_ v4's `@theme` directive makes design tokens **real CSS custom
properties**, so the same token is available to Tailwind utilities, hand-written
CSS, and JavaScript (`getComputedStyle`) — the last one matters because the 3D
scene reads its palette from the token layer rather than duplicating hex values.
Zero-runtime, and the utility constraint is what keeps spacing and colour
consistent across a large surface.

_Cost:_ verbose class strings; a real learning curve; v4 is recent enough that
some ecosystem plugins lag.

#### E — CSS Modules / vanilla-extract

**Rejected because:** they do not impose a scale, so consistency depends on
discipline. Tailwind's constraint _is_ the value.

#### F — styled-components / Emotion

**Rejected because:** runtime CSS-in-JS conflicts with Server Components and
adds bundle weight and hydration cost to an operator surface that must be fast.

### Component library

#### G — First-party primitives (chosen)

_Why:_ the design brief explicitly rules out looking like a stock template, and
"a standard shadcn demo" is named as a failure mode. Component libraries carry a
visual signature that is expensive to remove — you fight the defaults forever.
We need roughly a dozen primitives for Stage 1; owning them is cheap and gives
exact control over focus, motion and density.

_Cost:_ we own accessibility for every primitive we write. Accepted for simple
ones; explicitly **not** accepted for complex widgets — see the revisit trigger.

#### H — shadcn/ui

_Attractive because:_ excellent, copy-in (not a dependency), Radix underneath.

**Rejected because:** its visual identity is now instantly recognisable, and
adopting it means either shipping the look we were told not to ship, or
rewriting the styling of every component anyway — at which point the remaining
value is Radix, which we can adopt directly when we need it.

#### I — MUI / Chakra / Ant Design

**Rejected because:** strong opinionated visual identity, large bundles, runtime
theming systems that conflict with a token-first approach.

### Motion

#### J — `motion` (chosen)

_Why:_ declarative orchestration, layout animations, and a first-class
`useReducedMotion` — motion sequencing for the login transition would otherwise
be hand-rolled `requestAnimationFrame` code. Tree-shakes reasonably and is
imported only where used.

#### K — CSS transitions only

**Rejected because:** the login → dashboard choreography is a multi-stage
sequence coordinated with a WebGL scene and a route change. Expressing that in
CSS alone would be less legible and harder to test than an explicit state
machine plus a motion library. CSS transitions remain the default for the
_micro_ tier — the library is not used for hover states.

### Typography

#### L — Geist Sans + Geist Mono via the `geist` package (chosen)

_Why:_ self-hosted font files in the package, so builds need no network access
and there is no third-party font request at runtime (a privacy and LCP win). A
neutral technical grotesque with a genuinely good monospace companion — the
monospace matters because metrics are a primary content type here.

_Acknowledged cost:_ Geist is associated with Vercel's own products, so it
carries a mild "developer tool" association. We accept it: distinctiveness in
this product comes from the token system, density and motion, not the typeface.
Recorded so a future brand pass can revisit deliberately.

#### M — Google Fonts via `next/font/google`

**Rejected because:** it fetches at build time, so builds require network access,
and it adds a dependency on an external service for a core brand asset.

## Consequences

### Positive

- Tenant-scoped data is fetched server-side; no API token ever reaches the
  browser.
- Tokens are shared by CSS, Tailwind and the WebGL scene from one definition.
- Complete control over the visual identity and over focus/motion behaviour.
- No component-library upgrade treadmill.

### Negative

- We own the accessibility of every primitive we write.
- Next.js coupling in `apps/web` (contained by design).
- Tailwind v4 is recent; some tooling lags.

### Risks and mitigations

| Risk                                                           | Mitigation                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-party primitives ship a11y bugs                          | Component tests assert labelling, focus and keyboard behaviour; jsdom-based tests run in CI                                                             |
| Complex widgets (combobox, dialog, menu) are hard to get right | **Adopt Radix primitives unstyled** when we need them, rather than writing our own. Named explicitly so the decision is not re-litigated under deadline |
| Server/client boundary confusion leaks secrets                 | Only `NEXT_PUBLIC_*` is exposed; env access is centralised and validated in `packages/contracts/src/env.ts`                                             |

## Revisit when

- A complex interactive widget is required → add Radix primitives (unstyled).
- Bundle budget is exceeded → re-evaluate `motion` usage.
- A brand identity pass happens → revisit the typeface deliberately.

## Related

- [design/design-system.md](../design/design-system.md)
- [ADR-0007](ADR-0007-3d-stack.md), [ADR-0008](ADR-0008-login-transition-architecture.md)
