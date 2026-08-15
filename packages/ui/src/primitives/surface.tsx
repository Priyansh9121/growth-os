import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Elevation container.
 *
 * Implements the design system's five elevation levels. Structure comes from a
 * luminance step plus a hairline border; shadow is added only at levels 3 and
 * 4, where an element genuinely floats above the page.
 *
 * @see docs/design/design-system.md §5 Surfaces & elevation
 */
export type SurfaceLevel = 0 | 1 | 2 | 3 | 4;

const LEVEL_CLASSES: Record<SurfaceLevel, string> = {
  0: 'bg-canvas',
  1: 'bg-surface-1 border border-line',
  2: 'bg-surface-2 border border-line',
  3: 'bg-surface-3 border border-line-strong shadow-md',
  4: 'bg-surface-3 border border-line-strong shadow-lg',
};

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  readonly level?: SurfaceLevel;
  readonly interactive?: boolean;
}

export function Surface({ level = 1, interactive = false, className, ...rest }: SurfaceProps) {
  return (
    <div
      className={cn(
        'rounded-lg',
        LEVEL_CLASSES[level],
        interactive &&
          'transition-[background-color,border-color] duration-[120ms] ease-standard hover:border-line-strong hover:bg-surface-2',
        className,
      )}
      {...rest}
    />
  );
}
