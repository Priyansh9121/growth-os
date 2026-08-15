# Design System

**Status:** Implemented (Stage 1)
**Last reviewed:** 2026-08-15
**Source of truth:** [`packages/ui/src/tokens/tokens.css`](../../packages/ui/src/tokens/tokens.css)

Tokens are defined once, as CSS custom properties inside Tailwind v4's `@theme`
block. That single definition is consumed by:

- Tailwind utilities (`bg-surface-1`, `text-muted`, `rounded-lg`)
- hand-written CSS
- **the WebGL scene**, which reads its palette via `getComputedStyle` rather
  than duplicating hex values

**Rule: no raw colour, spacing, radius, duration or easing value may appear in a
component.** If a value is needed that does not exist, add a token — or justify
why the exception is correct.

---

## 1. Colour

Colours are authored in **OKLCH** for perceptually even steps: lightness is
predictable, so a surface ramp reads as evenly spaced rather than clumping in
the middle the way an HSL ramp does.

### Neutrals — cool graphite

| Token                 | Dark                     | Role                             |
| --------------------- | ------------------------ | -------------------------------- |
| `--color-canvas`      | `oklch(0.145 0.012 255)` | Page background                  |
| `--color-surface-1`   | `oklch(0.185 0.013 255)` | Cards, panels                    |
| `--color-surface-2`   | `oklch(0.222 0.014 255)` | Raised, hover                    |
| `--color-surface-3`   | `oklch(0.262 0.015 255)` | Popovers, dialogs                |
| `--color-line`        | `oklch(0.30 0.014 255)`  | Hairline borders                 |
| `--color-line-strong` | `oklch(0.40 0.016 255)`  | Emphasised dividers, focus rings |
| `--color-text`        | `oklch(0.97 0.004 255)`  | Primary text                     |
| `--color-text-muted`  | `oklch(0.74 0.012 255)`  | Secondary text                   |
| `--color-text-subtle` | `oklch(0.60 0.012 255)`  | Tertiary, placeholders           |

Elevation is expressed as a **luminance step plus a hairline**, not a shadow.
See §5.

### Accents

| Token                   | Value                  | Meaning — used **only** for this                                                  |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `--color-signal`        | `oklch(0.80 0.15 165)` | Live, measured, working. Primary actions, active nav, positive delta, AI presence |
| `--color-signal-strong` | `oklch(0.87 0.16 168)` | Hover/emphasis on signal                                                          |
| `--color-signal-dim`    | `oklch(0.52 0.09 165)` | Signal at rest, borders, lattice edges                                            |
| `--color-attention`     | `oklch(0.80 0.14 78)`  | Opportunity, warning, needs action                                                |
| `--color-critical`      | `oklch(0.66 0.19 25)`  | Failure, destructive, negative delta                                              |
| `--color-info`          | `oklch(0.75 0.11 230)` | Neutral informational                                                             |

**Discipline:** the signal accent should cover ≲5% of a screen. If everything is
highlighted, nothing is.

### Data visualisation

An ordered categorical sequence, chosen for distinguishability under both common
colour-vision deficiencies and greyscale printing:

`--color-viz-1` signal green · `--color-viz-2` azure · `--color-viz-3` violet ·
`--color-viz-4` amber · `--color-viz-5` rose · `--color-viz-6` teal

Series identity must never rest on colour alone — pair with direct labels,
dash patterns or markers.

### Light theme

Defined in the same file under `:root[data-theme='light']` and
`@media (prefers-color-scheme: light)` for the unset case. Light is a re-mapping,
not an inversion: hairlines darken, the accent darkens to hold ≥4.5:1 on white,
and elevation moves from luminance steps to shadow.

### Contrast commitments

| Pair                                                      | Minimum                                       |
| --------------------------------------------------------- | --------------------------------------------- |
| Body text on any surface                                  | 4.5:1                                         |
| Large text (≥18.66px bold / ≥24px)                        | 3:1                                           |
| Interactive borders, focus rings, icons conveying meaning | 3:1                                           |
| Disabled text                                             | Exempt, but never the sole indicator of state |

Verified by [`packages/ui/src/tokens/contrast.test.ts`](../../packages/ui/src/tokens/contrast.test.ts),
which computes real WCAG contrast ratios from the token values and fails CI on
regression. Contrast is a build gate, not an assertion in a document.

---

## 2. Spacing

A 4px base grid. **Only these steps exist.**

| Token       | px  | Typical use                       |
| ----------- | --- | --------------------------------- |
| `space-0.5` | 2   | Icon nudges                       |
| `space-1`   | 4   | Icon↔label                        |
| `space-2`   | 8   | Inside compact controls           |
| `space-3`   | 12  | Control padding                   |
| `space-4`   | 16  | Card padding (compact), stack gap |
| `space-5`   | 20  |                                   |
| `space-6`   | 24  | Card padding (default)            |
| `space-8`   | 32  | Section gap                       |
| `space-10`  | 40  |                                   |
| `space-12`  | 48  | Major section gap                 |
| `space-16`  | 64  | Page top padding                  |
| `space-24`  | 96  | Threshold surfaces only (login)   |

Density rule: the operator surface lives in 8/12/16/24. The 64/96 steps belong
to the login and to empty states.

---

## 3. Typography

| Token           | Size / line-height | Tracking           | Use                  |
| --------------- | ------------------ | ------------------ | -------------------- |
| `text-display`  | 44 / 48            | −0.03em            | Login headline only  |
| `text-h1`       | 30 / 36            | −0.025em           | Page title           |
| `text-h2`       | 22 / 28            | −0.02em            | Section              |
| `text-h3`       | 17 / 24            | −0.015em           | Card title           |
| `text-body-lg`  | 16 / 24            | −0.005em           | Threshold surfaces   |
| `text-body`     | 14 / 20            | 0                  | **Operator default** |
| `text-sm`       | 13 / 18            | 0                  | Secondary            |
| `text-caption`  | 12 / 16            | +0.01em            | Labels, metadata     |
| `text-overline` | 11 / 14            | +0.08em, uppercase | Nav group headings   |

### Metrics

Metrics use **Geist Mono with `tabular-nums`**, always:

| Token            | Size / line-height |
| ---------------- | ------------------ |
| `text-metric-lg` | 40 / 44            |
| `text-metric`    | 28 / 32            |
| `text-metric-sm` | 18 / 22            |

Tabular figures mean digits do not shift width as a value animates, and columns
of numbers align. This is a correctness property, not decoration.

---

## 4. Radius

| Token         | px   | Use                   |
| ------------- | ---- | --------------------- |
| `radius-xs`   | 4    | Badges, tags          |
| `radius-sm`   | 6    | Inputs, small buttons |
| `radius-md`   | 8    | Buttons, controls     |
| `radius-lg`   | 12   | Cards, panels         |
| `radius-xl`   | 16   | Login card, modals    |
| `radius-2xl`  | 24   | Hero surfaces         |
| `radius-full` | 9999 | Pills, avatars        |

Nested radii follow `inner = outer − padding`, so concentric corners stay
optically parallel.

---

## 5. Surfaces & elevation

Five levels. Elevation is **luminance + hairline first**, shadow only when an
element genuinely floats.

| Level | Composition                                   | Use                 |
| ----- | --------------------------------------------- | ------------------- |
| 0     | `canvas`                                      | Page                |
| 1     | `surface-1` + 1px `line`                      | Cards, sidebar      |
| 2     | `surface-2` + 1px `line`                      | Hover, selected     |
| 3     | `surface-3` + 1px `line-strong` + `shadow-md` | Popovers, dropdowns |
| 4     | `surface-3` + 1px `line-strong` + `shadow-lg` | Dialogs             |

```
--shadow-sm: 0 1px 2px oklch(0 0 0 / 0.25);
--shadow-md: 0 4px 16px -4px oklch(0 0 0 / 0.35);
--shadow-lg: 0 16px 48px -12px oklch(0 0 0 / 0.5);
```

### Glass — restricted

Backdrop blur is permitted on exactly three things: the login card, the sticky
top bar, and full-screen overlays. Everywhere else it costs GPU time and
legibility for decoration.

When used: `backdrop-filter: blur(20px) saturate(1.4)` over a ≥70%-opaque
surface, so text contrast never depends on what is behind it.

---

## 6. Focus

Focus is a **safety feature**. It is never removed.

```css
--focus-ring: 0 0 0 2px var(--color-canvas), 0 0 0 4px var(--color-signal);
```

A two-layer ring (canvas gap, then accent) stays visible on any surface. Applied
via `:focus-visible` so pointer users do not see it, keyboard users always do.
Interactive elements reserve space so focus never causes layout shift.

---

## 7. Interaction states

Every interactive element defines all seven. A component missing `:focus-visible`
or a loading state is incomplete.

| State         | Treatment                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------- |
| Rest          | Base                                                                                          |
| Hover         | +1 surface level, or border → `line-strong`. 120ms                                            |
| Focus-visible | Focus ring. **No transition** — instant                                                       |
| Active        | Return to rest surface, `scale(0.985)`. 80ms                                                  |
| Disabled      | 45% opacity, `cursor: not-allowed`, `aria-disabled`. Never the only signal                    |
| Loading       | Spinner replaces label, **width preserved** to prevent layout shift; `aria-busy`              |
| Error         | `--color-critical` border, message linked by `aria-describedby`, announced via `role="alert"` |

---

## 8. Content states

Every data surface implements four. Missing states are the most common way a
polished product suddenly looks unfinished.

**Loading** — skeletons that match the real content's geometry, with a slow
shimmer (1.6s, `--ease-standard`). Never a centred spinner for a whole page.
Suppressed under `prefers-reduced-motion` (static tint instead).

**Empty** — states _why_ it is empty and gives the next action. Distinguishes
"nothing here yet" from "not connected" from "no results for this filter". Never
shows a zero standing in for missing data (Principle 3).

**Error** — human-readable cause, a retry where retrying could help, and a
correlation ID for support. Never a stack trace, never a raw error code alone.

**Populated** — the real thing.

---

## 9. Iconography

Line icons, 1.5px stroke, 20px default (16px dense, 24px prominent), drawn on a
24px grid, `currentColor`. First-party SVG components — no icon-font, no runtime
icon package. Decorative icons get `aria-hidden="true"`; meaningful icons get an
accessible name.

---

## 10. Breakpoints

| Token | min-width | Target                                |
| ----- | --------- | ------------------------------------- |
| `sm`  | 640px     | Large phone                           |
| `md`  | 768px     | Tablet portrait                       |
| `lg`  | 1024px    | Tablet landscape / small laptop       |
| `xl`  | 1280px    | Desktop — **primary operator target** |
| `2xl` | 1536px    | Large desktop                         |

Mobile-first. Behaviour per surface is specified in
[responsive-behaviour.md](responsive-behaviour.md).

---

## 11. Motion

Summarised here, specified in [motion-system.md](motion-system.md).

| Tier       | Duration  | Use                                  |
| ---------- | --------- | ------------------------------------ |
| Micro      | 100–180ms | Hover, focus, toggle, press          |
| Standard   | 200–350ms | Panels, menus, cards, content        |
| Expressive | 450–900ms | Login, route threshold, hero moments |

Everyday dashboard navigation uses **micro and standard only**.

---

## 12. Adding to the system

1. Does an existing token express it? Use that.
2. Will it be used in ≥3 places? If not, it is a local value — not a token.
3. Does it have a _semantic_ name (`--color-signal`), not a descriptive one
   (`--color-green-400`)? Semantic names survive a rebrand.
4. Add it to `tokens.css`, document it here, and add a contrast test if it is a
   colour used for text or a border that conveys meaning.
