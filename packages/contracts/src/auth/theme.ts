/**
 * The user's theme preference.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One vocabulary for "which palette does this person see", shared by the
 * database enum, the settings form and the script that applies the choice
 * before paint. A second list would let the column and the UI disagree about
 * what a valid theme is.
 *
 * ⚠️ THE PALETTES ALREADY EXIST. `packages/ui/src/tokens/tokens.css` has
 * carried a full `:root[data-theme='light']` palette, contrast tests and
 * documentation since the design system landed. What did not exist was any way
 * to REACH it: the root layout hardcoded `data-theme="dark"`, so the light
 * tokens were unreachable and the `prefers-color-scheme` block below them was
 * dead. This vocabulary is the missing switch, not a new design.
 *
 * ⚠️ `auto` IS DELIBERATELY ABSENT, for now.
 * `tokens.css` already honours `prefers-color-scheme` whenever `data-theme` is
 * absent, so an OS-following option is a value away — but this brief is
 * explicit-choice-only, and shipping a third value the settings page does not
 * offer would put a state in the database that nothing can produce or clear.
 * `FORM_THEMES` (public forms) does carry `auto`; the two lists are separate
 * because they answer different questions — one is a form's embedded
 * appearance, this is a person's account preference.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { z } from 'zod';

/**
 * ⚠️ ORDER IS THE ORDER THE SETTINGS PAGE RENDERS, so the default comes first
 * and the quiet alternatives follow. It is NOT the database enum's order —
 * PostgreSQL appends new values, so `theme_preference` is stored as
 * `dark, light, growth-bright, growth-dark, growth-warm`. Nothing sorts on
 * either, and a test asserts the two lists agree as SETS rather than sequences.
 */
export const THEME_PREFERENCES = [
  'growth-bright',
  'growth-dark',
  'growth-warm',
  'dark',
  'light',
] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * The default for accounts created from now on.
 *
 * ⚠️ THIS REVERSES ADR-0056's DEFAULT, DELIBERATELY (ADR-0057). It is the one
 * place this change is not purely additive.
 *
 * It does NOT move anybody. `users.theme_preference` is `NOT NULL`, so every
 * account that exists is stored with an explicit value — `dark` for anyone who
 * never chose — and a column DEFAULT only applies to rows that omit it at
 * INSERT. Verified on a throwaway database rather than reasoned about: a row
 * written before the default changed still read `dark` afterwards, while a row
 * written after read `growth-bright`.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'growth-bright';

export const THEME_PREFERENCE_LABELS: Readonly<Record<ThemePreference, string>> = {
  'growth-bright': 'Growth',
  'growth-dark': 'Growth Dark',
  'growth-warm': 'Growth Warm',
  dark: 'Dark',
  light: 'Light',
};

/**
 * What each theme is for, shown beside the choice.
 *
 * Descriptions rather than swatches alone: a theme picker whose only signal is
 * colour is unusable for anyone who cannot distinguish the swatches, which is
 * the same reason `docs/design/design-system.md` forbids colour-only series
 * identity in charts. With five options that stops being a nicety — "Growth"
 * and "Growth Dark" are not tellable apart by name.
 */
export const THEME_PREFERENCE_DESCRIPTIONS: Readonly<Record<ThemePreference, string>> = {
  'growth-bright': 'The default. Bright, with a confident green accent.',
  'growth-dark': 'The same energy after dark — deep green surfaces, a glowing accent.',
  'growth-warm': 'Amber rather than green. Warmer, and less like a trading terminal.',
  dark: 'Quiet and neutral. Cool graphite surfaces, tuned for long sessions.',
  light: 'Quiet and neutral. Bright surfaces with a deeper accent, for well-lit rooms.',
};

/** Parses a value from the wire. Anything else is refused, never defaulted. */
export const themePreferenceSchema = z.enum(THEME_PREFERENCES);

export const updateThemePreferenceSchema = z.object({
  theme: themePreferenceSchema,
});

export type UpdateThemePreferenceInput = z.infer<typeof updateThemePreferenceSchema>;

/**
 * Narrow an untrusted string to a theme, falling back to the default.
 *
 * ⚠️ FOR READ PATHS ONLY — a stale cookie, a column read by an older build.
 * A WRITE must use `themePreferenceSchema` and REFUSE an unknown value, or a
 * typo silently becomes "dark" and the user is told their choice was saved.
 */
export function themePreferenceOr(
  value: string | null | undefined,
  fallback: ThemePreference = DEFAULT_THEME_PREFERENCE,
): ThemePreference {
  const parsed = themePreferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
