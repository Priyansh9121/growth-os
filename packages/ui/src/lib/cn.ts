import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose class names, resolving Tailwind conflicts in favour of the last one.
 *
 * `clsx` handles conditionals; `twMerge` resolves collisions, so a component's
 * default `px-4` is genuinely overridden by a caller's `px-6` instead of both
 * landing in the class list and letting stylesheet order decide. Without it,
 * every component needs bespoke override plumbing.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
