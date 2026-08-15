/**
 * The Growth OS mark.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The product's identity glyph: a source node with three outbound signal
 * paths — the smallest possible expression of "one thing causes measurable
 * others".
 *
 * WHY VECTOR GEOMETRY RATHER THAN AN IMAGE ASSET
 *  1. It renders at any size with no asset pipeline and no network request.
 *  2. It inherits `currentColor`, so it is correct in both themes for free.
 *  3. **The 3D login lattice converges into this exact geometry.** Keeping the
 *     mark as coordinates rather than pixels is what lets the WebGL scene
 *     resolve into it during the sign-in transition.
 *
 * The `pulse` variant animates the signal paths drawing outward and is used
 * only at threshold moments (sign-in success). It respects reduced motion via
 * the CSS media query in the token layer.
 *
 * @see docs/design/brand-direction.md §The mark
 */

import { cn } from '../lib/cn';

export interface GrowthMarkProps {
  readonly size?: number;
  readonly className?: string;
  /** Animate the outbound paths. Threshold moments only. */
  readonly pulse?: boolean;
  /** Accessible name. Omit when the mark sits beside a visible wordmark. */
  readonly title?: string;
}

/**
 * Node positions on a 24×24 grid, shared with the 3D lattice's convergence
 * target. Changing these changes both the logo and the login transition.
 */
export const MARK_GEOMETRY = {
  source: { x: 6, y: 12 },
  targets: [
    { x: 18, y: 5 },
    { x: 19, y: 12 },
    { x: 18, y: 19 },
  ],
} as const;

export function GrowthMark({ size = 24, className, pulse = false, title }: GrowthMarkProps) {
  const { source, targets } = MARK_GEOMETRY;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      // Decorative unless given a title — the wordmark usually supplies the name.
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={cn('shrink-0', className)}
    >
      {title ? <title>{title}</title> : null}

      {targets.map((target, index) => (
        <path
          key={`edge-${target.x}-${target.y}`}
          // Quadratic curve bowing away from the axis, so the three paths read
          // as distinct routes rather than a fan of straight lines.
          d={`M ${source.x} ${source.y} Q ${(source.x + target.x) / 2} ${
            source.y + (target.y - source.y) * 0.25
          } ${target.x} ${target.y}`}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          opacity={0.45}
          className={pulse ? 'growth-mark-path' : undefined}
          style={pulse ? { animationDelay: `${index * 90}ms` } : undefined}
        />
      ))}

      {targets.map((target) => (
        <circle
          key={`node-${target.x}-${target.y}`}
          cx={target.x}
          cy={target.y}
          r={1.75}
          fill="currentColor"
          opacity={0.7}
        />
      ))}

      {/* Source node, drawn last so it sits above the paths. */}
      <circle cx={source.x} cy={source.y} r={3.25} fill="currentColor" />
    </svg>
  );
}

/** Mark plus wordmark. */
export function GrowthWordmark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <GrowthMark size={size} className="text-signal" />
      <span className="text-h3 font-semibold tracking-tight text-text">Growth OS</span>
    </span>
  );
}
