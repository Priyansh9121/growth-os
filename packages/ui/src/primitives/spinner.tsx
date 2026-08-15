import { cn } from '../lib/cn';

/**
 * Loading spinner.
 *
 * Used ONLY for in-place feedback on a control the user just activated
 * (a submitting button). Page-level loading uses skeletons instead — a centred
 * spinner tells the user nothing about what is arriving, while a skeleton
 * previews the shape of it.
 *
 * Marked `aria-hidden`: the surrounding control already announces its state
 * via `aria-busy`, so announcing the spinner too would be duplicate noise.
 */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn('animate-spin', className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
