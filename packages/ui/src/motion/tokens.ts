/**
 * Motion tokens for JavaScript-driven animation.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The CSS in `tokens/tokens.css` covers CSS transitions. This file provides
 * the same values to `motion` and to the WebGL scene, which need numbers
 * rather than CSS strings.
 *
 * The two MUST stay in agreement; `motion/tokens.test.ts` asserts that every
 * duration here has a matching custom property in the stylesheet, so a change
 * in one place without the other fails CI.
 *
 * @see docs/design/motion-system.md
 */

/** Durations in milliseconds, grouped by tier. */
export const duration = {
  /** Focus feedback is never animated — delaying it is an accessibility failure. */
  instant: 0,

  // Micro — direct manipulation. The user's cursor is on the element.
  press: 80,
  micro: 120,
  toggle: 160,

  // Standard — requested interface changes. The dashboard lives here.
  fast: 200,
  standard: 260,
  slow: 320,

  // Expressive — threshold moments only, roughly once per session.
  expressive: 520,
  threshold: 720,
  /** The longest duration permitted anywhere in the product. */
  cinematic: 900,
} as const;

export type DurationToken = keyof typeof duration;

/**
 * Easing curves as cubic-bezier control points, for libraries that take arrays.
 *
 * No spring or bounce curves exist by design: overshoot reads as playful, and
 * the brand target is calm authority.
 */
export const ease = {
  standard: [0.2, 0, 0, 1],
  entrance: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1],
  /** Symmetric — physical objects and cameras do not snap. */
  spatial: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type EaseToken = keyof typeof ease;

/** Delay between consecutive items in a staggered entrance. */
export const STAGGER_MS = 40;

/**
 * Maximum items in one staggered group.
 *
 * At 40ms each, six items means the last starts at 240ms. Beyond that the
 * stagger stops reading as sequence and starts reading as lag.
 */
export const MAX_STAGGER_ITEMS = 6;

/**
 * The dashboard entrance choreography.
 *
 * Ordered by importance, not by position on screen — the stagger is what
 * communicates hierarchy, so the order must actually reflect it.
 */
export const DASHBOARD_ENTRANCE = [
  { id: 'shell', delay: 0, duration: duration.slow },
  { id: 'sidebar', delay: 60, duration: duration.slow },
  { id: 'topbar', delay: 100, duration: duration.standard },
  { id: 'hero', delay: 160, duration: duration.expressive },
  { id: 'cards', delay: 240, duration: duration.slow },
  { id: 'ai', delay: 420, duration: duration.slow },
] as const;

export type DashboardEntranceStep = (typeof DASHBOARD_ENTRANCE)[number]['id'];

/** Look up a step's timing. Returns `undefined` for an unknown id. */
export function entranceStep(id: DashboardEntranceStep) {
  return DASHBOARD_ENTRANCE.find((step) => step.id === id);
}
