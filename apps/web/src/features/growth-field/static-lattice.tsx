/**
 * The Growth Lattice — static composition.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The non-WebGL rendering of the same concept: identical nodes, identical
 * causal loop, identical palette, zero GPU cost. Shown under reduced motion,
 * without WebGL, on mobile and on low-powered devices.
 *
 * WHY IT SHARES `LATTICE_NODES` WITH THE 3D SCENE
 * One definition of the lattice means the two compositions cannot drift into
 * telling different stories. The 3D positions are projected orthographically
 * into the SVG viewBox here.
 *
 * This is a *designed alternative*, not an apology. Most mobile users will
 * only ever see this, and it must feel premium on its own terms.
 *
 * @see docs/design/3d-system.md §2
 */

import { LATTICE_CHORDS, LATTICE_EDGES, LATTICE_NODES } from './lattice-geometry';

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 420;

/** Orthographic projection of the 3D lattice into the SVG plane. */
function project(position: readonly [number, number, number]): {
  x: number;
  y: number;
  depth: number;
} {
  const [x, y, z] = position;
  // Slight z-scaling so nodes further back sit marginally inward, which reads
  // as depth without any perspective maths.
  const depthScale = 1 + z * 0.012;
  return {
    x: VIEW_WIDTH / 2 + x * 58 * depthScale,
    y: VIEW_HEIGHT / 2 - y * 58 * depthScale,
    // Normalised 0–1, where 1 is nearest. Drives opacity and radius.
    depth: (z + 4) / 8,
  };
}

export interface StaticLatticeProps {
  /** `ambient` for the desktop background; `compact` for the mobile motif. */
  readonly variant?: 'ambient' | 'compact';
  readonly className?: string;
}

export function StaticLattice({ variant = 'ambient', className }: StaticLatticeProps) {
  const projected = LATTICE_NODES.map((node) => ({ node, ...project(node.position) }));
  const edges = [...LATTICE_EDGES, ...LATTICE_CHORDS];
  const compact = variant === 'compact';

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      // Decorative: the lattice carries no information the user needs.
      // No information may exist only inside this composition.
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
      className={className}
    >
      <defs>
        <radialGradient id="gos-lattice-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-signal)" stopOpacity={compact ? 0.16 : 0.1} />
          <stop offset="100%" stopColor="var(--color-signal)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse
        cx={VIEW_WIDTH / 2}
        cy={VIEW_HEIGHT / 2}
        rx={VIEW_WIDTH * 0.42}
        ry={VIEW_HEIGHT * 0.44}
        fill="url(#gos-lattice-glow)"
      />

      {edges.map(([fromIndex, toIndex]) => {
        const from = projected[fromIndex];
        const to = projected[toIndex];
        if (!from || !to) return null;

        return (
          <line
            key={`edge-${fromIndex}-${toIndex}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="var(--color-signal-dim)"
            strokeWidth={1}
            // Nearer edges are marginally brighter — the only depth cue
            // available without perspective.
            opacity={0.16 + ((from.depth + to.depth) / 2) * 0.2}
          />
        );
      })}

      {projected.map(({ node, x, y, depth }) => (
        <g key={node.id}>
          <circle
            cx={x}
            cy={y}
            r={(compact ? 3.5 : 4.5) + node.weight * 2}
            fill="var(--color-signal)"
            opacity={0.5 + depth * 0.4}
          />
          <circle
            cx={x}
            cy={y}
            r={(compact ? 8 : 11) + node.weight * 4}
            fill="none"
            stroke="var(--color-signal)"
            strokeWidth={0.75}
            opacity={0.16 + depth * 0.14}
          />
          {!compact ? (
            <text
              x={x}
              y={y + 26}
              textAnchor="middle"
              fill="var(--color-text-subtle)"
              fontSize={9}
              letterSpacing="0.08em"
              fontFamily="var(--font-mono)"
            >
              {node.label}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
