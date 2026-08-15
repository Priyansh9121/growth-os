# @growth-os/ui

The Growth OS design system: tokens, motion tokens and accessible React
primitives.

## Why it exists

One definition of the visual language, so any future surface (agency console,
admin, white-label) inherits it rather than re-inventing it.

## Responsibilities

- **`src/tokens/tokens.css` — the single source of truth** for every colour,
  space, radius, type step, shadow, duration and easing
- Accessible primitives: Button, Field, Surface, Badge, Skeleton, Spinner,
  GrowthMark, VisuallyHidden
- Motion tokens and `useReducedMotion`

## NOT its responsibilities

Business logic, data fetching, or knowledge of sessions, tenancy or the
database. **A design system that knows about the database is not a design
system** — hence `ui → anything internal` is a forbidden edge.

## Dependencies

React, `clsx`, `tailwind-merge`. **Nothing internal**, enforced by lint.

## Why tokens are CSS, not TypeScript

Because the WebGL login scene reads its palette via `getComputedStyle`. One
definition serves Tailwind utilities, hand-written CSS **and** the 3D scene, so
the scene cannot drift from the design system — it owns no colours of its own.

## Rules

- **No raw colour, spacing, radius, duration or easing in a component.** Add a
  token, or justify the exception.
- Semantic token names (`--color-signal`), never descriptive
  (`--color-green-400`). A semantic name survives a rebrand;
  `--color-green-400: red` is a real thing that happens.
- Every interactive primitive implements all seven states, including
  `:focus-visible` and loading.

## Two details that look cosmetic and are not

- **A loading button uses `aria-disabled`, not `disabled`.** A `disabled` button
  leaves the accessibility tree and loses focus, dropping a screen-reader user
  to the top of the document mid-submit.
- **Loading preserves the button's width.** The label stays mounted at
  `opacity: 0` with the spinner over it, so the target does not move under the
  user's cursor.

## Testing

`tokens/contrast.test.ts` computes real WCAG contrast ratios from the token
values and fails CI on regression — it has already caught two genuine
light-theme failures. Contrast is a build gate, not a claim in a document.
