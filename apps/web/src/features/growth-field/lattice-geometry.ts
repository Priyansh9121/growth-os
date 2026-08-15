/**
 * Geometry and palette for the Growth Lattice.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Pure data and pure maths. No React, no three.js. Keeping the geometry
 * separable means it can be unit-tested and reused by the static fallback,
 * which renders the same lattice as SVG.
 *
 * @see docs/design/3d-system.md
 * @see docs/design/login-experience.md §2
 */

/** A stage of the growth loop, as a node in the lattice. */
export interface LatticeNode {
  readonly id: string;
  readonly label: string;
  /** Position in scene units. */
  readonly position: readonly [number, number, number];
  /** Relative visual weight, 0–1. Drives node size and edge brightness. */
  readonly weight: number;
}

/**
 * The seven loop stages, arranged as a closed ellipse with varying depth.
 *
 * WHY VARYING Z
 * A flat ring gives nothing for parallax or the camera push to work against —
 * it would read as a 2D diagram that happens to be rendered in WebGL. Spread
 * across roughly 4 units of depth, the same motion reads as real space.
 *
 * Order is causal, and the last edge closes the loop back to SEARCH, which is
 * the visual argument the whole scene exists to make.
 */
export const LATTICE_NODES: readonly LatticeNode[] = [
  { id: 'search', label: 'SEARCH', position: [-4.6, 1.5, -1.4], weight: 0.9 },
  { id: 'site', label: 'SITE', position: [-2.5, 2.5, 0.9], weight: 0.75 },
  { id: 'lead', label: 'LEAD', position: [0.4, 2.1, 1.9], weight: 0.85 },
  { id: 'ai', label: 'AI', position: [2.9, 0.7, 0.6], weight: 1 },
  { id: 'booking', label: 'BOOKING', position: [3.5, -1.5, -1.1], weight: 0.8 },
  { id: 'revenue', label: 'REVENUE', position: [1.1, -2.6, -2.0], weight: 0.95 },
  { id: 'optimise', label: 'OPTIMISE', position: [-2.6, -1.8, -0.8], weight: 0.7 },
];

/** Directed edges, closing the loop. */
export const LATTICE_EDGES: readonly (readonly [number, number])[] = LATTICE_NODES.map(
  (_, index) => [index, (index + 1) % LATTICE_NODES.length] as const,
);

/**
 * Extra chords across the loop.
 *
 * Purely visual: they make the structure read as a lattice rather than a
 * necklace. Kept to three so the scene stays legible — a fully connected graph
 * would be noise, which is the failure mode `3d-system.md` warns about.
 */
export const LATTICE_CHORDS: readonly (readonly [number, number])[] = [
  [0, 3],
  [2, 5],
  [1, 6],
];

/**
 * Convergence targets, derived from the Growth OS mark.
 *
 * The mark is authored on a 24×24 grid (see `MARK_GEOMETRY` in
 * `@growth-os/ui`); these are those coordinates mapped into scene space and
 * centred on the origin. During the sign-in transition every node lerps to one
 * of these, so the lattice literally resolves into the product's logo.
 *
 * Seven nodes map onto four mark points, so three converge onto the source
 * node — which is correct: the source is the mark's visual anchor and should
 * gain mass as the structure collapses.
 */
export const CONVERGENCE_TARGETS: readonly (readonly [number, number, number])[] = [
  [-1.5, 0, 0], // source
  [1.5, 1.75, 0], // upper branch
  [1.75, 0, 0], // middle branch
  [1.5, -1.75, 0], // lower branch
  [-1.5, 0, 0],
  [-1.5, 0, 0],
  [-1.5, 0, 0],
];

/** Points sampled per edge for the travelling signal pulses. */
export const SIGNALS_PER_EDGE = 3;

/** Sparse depth field behind the lattice, for the camera push to travel through. */
export const DEPTH_FIELD_COUNT = 140;

/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * The depth field must be identical on every load: a scene that reshuffles
 * each visit looks unstable, and a non-deterministic scene cannot be
 * screenshot-tested. `Math.random()` would give neither property.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Depth-field positions as a flat Float32Array, ready for a BufferAttribute. */
export function buildDepthField(count = DEPTH_FIELD_COUNT, seed = 0x9e37): Float32Array {
  const random = createRandom(seed);
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (random() - 0.5) * 26;
    positions[i * 3 + 1] = (random() - 0.5) * 16;
    // Always behind the lattice, so these never occlude the loop itself.
    positions[i * 3 + 2] = -6 - random() * 20;
  }

  return positions;
}

/** Flat `[x1,y1,z1, x2,y2,z2, ...]` pairs for a single `LineSegments`. */
export function buildEdgePositions(
  nodes: readonly LatticeNode[] = LATTICE_NODES,
  edges: readonly (readonly [number, number])[] = [...LATTICE_EDGES, ...LATTICE_CHORDS],
): Float32Array {
  const positions = new Float32Array(edges.length * 6);

  edges.forEach(([fromIndex, toIndex], edgeIndex) => {
    const from = nodes[fromIndex];
    const to = nodes[toIndex];
    if (!from || !to) return;

    positions.set(from.position, edgeIndex * 6);
    positions.set(to.position, edgeIndex * 6 + 3);
  });

  return positions;
}

/**
 * Read the design system's palette from CSS custom properties.
 *
 * WHY READ CSS RATHER THAN HARD-CODE HEX
 * The scene would otherwise hold a second, silently diverging copy of the
 * palette. Reading the tokens means the lattice follows a theme change or a
 * palette revision automatically, and the design system stays the single
 * source of truth (see design-system.md).
 *
 * Falls back to the dark-theme values when called outside a browser or before
 * styles resolve.
 */
export function readPalette(element?: Element | null): {
  signal: string;
  signalDim: string;
  attention: string;
  canvas: string;
} {
  const fallback = {
    signal: 'oklch(0.80 0.15 165)',
    signalDim: 'oklch(0.52 0.09 165)',
    attention: 'oklch(0.80 0.14 78)',
    canvas: 'oklch(0.145 0.012 255)',
  };

  if (typeof window === 'undefined') return fallback;

  const styles = getComputedStyle(element ?? document.documentElement);
  const read = (name: string, fallbackValue: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : fallbackValue;
  };

  return {
    signal: read('--color-signal', fallback.signal),
    signalDim: read('--color-signal-dim', fallback.signalDim),
    attention: read('--color-attention', fallback.attention),
    canvas: read('--color-canvas', fallback.canvas),
  };
}

/** Linear interpolation. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Smoothstep easing, matched to `--ease-spatial`'s symmetric feel.
 *
 * Used for convergence progress so the collapse accelerates and decelerates
 * like a physical object rather than starting and stopping abruptly.
 */
export function smoothstep(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}
