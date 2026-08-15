import type { HTMLAttributes } from 'react';

/**
 * Visible to screen readers, invisible on screen.
 *
 * Uses the clip-rect technique rather than `display: none` or
 * `visibility: hidden`, both of which remove the element from the
 * accessibility tree entirely — which defeats the purpose.
 */
export function VisuallyHidden(props: HTMLAttributes<HTMLSpanElement>) {
  return <span className="sr-only" {...props} />;
}
