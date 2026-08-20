import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Every font-size step in `tokens.css`, named for tailwind-merge.
 *
 * ⚠️ THIS LIST IS WHY THE PRIMARY BUTTON HAD A READABLE LABEL AGAIN.
 *
 * tailwind-merge classifies `text-*` into either a font-size group or a
 * text-colour group, using its knowledge of Tailwind's DEFAULT scale. Our scale
 * is bespoke (`text-body`, `text-metric-lg`, `text-overline`), so it recognised
 * none of them and fell back to treating every `text-*` as one group.
 *
 * The consequence was silent and total. `Button` composes
 * `VARIANT_CLASSES` (which carries `text-text-inverse`) and then
 * `SIZE_CLASSES` (which carries `text-body`); last-one-wins dropped the COLOUR
 * on every button in the product. Measured before the fix: the login page's
 * "Sign in" rendered its label in `--color-text` on a `--color-signal` fill —
 * 2.83:1 in growth-bright, 1.47:1 in growth-dark, failing 4.5:1 in all five
 * themes. The variant's own comment described a contrast protection that had
 * never once applied.
 *
 * Keeping this list in sync with `@theme`'s `--text-*` steps is asserted by a
 * test, so a new type step cannot quietly reintroduce the collision.
 *
 * @see docs/decisions/ADR-0058-dashboard-accent-emphasis.md
 */
export const FONT_SIZE_STEPS = [
  'display',
  'h1',
  'h2',
  'h3',
  'body-lg',
  'body',
  'sm',
  'caption',
  'overline',
  'metric-lg',
  'metric',
  'metric-sm',
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...FONT_SIZE_STEPS] }],
    },
  },
});

/**
 * Compose class names, resolving Tailwind conflicts in favour of the last one.
 *
 * `clsx` handles conditionals; `twMerge` resolves collisions, so a component's
 * default `px-4` is genuinely overridden by a caller's `px-6` instead of both
 * landing in the class list and letting stylesheet order decide. Without it,
 * every component needs bespoke override plumbing.
 *
 * A size and a colour are no longer treated as the same conflict — see
 * `FONT_SIZE_STEPS`. A caller overriding either still wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
