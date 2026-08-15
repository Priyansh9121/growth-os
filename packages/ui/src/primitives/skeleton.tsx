import { cn } from '../lib/cn';

/**
 * Loading placeholder.
 *
 * Skeletons match the geometry of the content they replace, so the layout does
 * not shift when real data arrives.
 *
 * The shimmer is a CSS animation, which the global `prefers-reduced-motion`
 * rule in the token layer reduces to a static tint — a sweeping gradient is
 * exactly the kind of repetitive motion that setting exists to suppress.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('animate-pulse rounded-sm bg-surface-2', className)} />
  );
}
