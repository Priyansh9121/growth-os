'use client';

/**
 * The theme chooser.
 *
 * ⚠️ IT APPLIES THE CHOICE OPTIMISTICALLY, THEN SAVES.
 * Setting `data-theme` on `<html>` before the request completes is what makes
 * this feel like a preference rather than a form submission — every token is a
 * CSS custom property, so the whole product repaints from that one attribute
 * with no re-render. On failure the attribute is put back, so the visible state
 * never disagrees with what is stored.
 *
 * ⚠️ A RADIO GROUP, NOT A TOGGLE. A two-value switch reads as "dark mode: on",
 * which stops being true the moment a third theme exists — and `auto` is one
 * enum value away (ADR-0056). Radios also give each option a real label and
 * description, which a switch cannot, and `docs/design/accessibility.md`'s rule
 * against colour as the only signal applies to a theme picker more than
 * anywhere else in the product.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { useId, useState, useTransition } from 'react';
import {
  THEME_PREFERENCES,
  THEME_PREFERENCE_DESCRIPTIONS,
  THEME_PREFERENCE_LABELS,
  type ThemePreference,
} from '@growth-os/contracts';

export function ThemeSetting({ initialTheme }: { initialTheme: ThemePreference }) {
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const groupId = useId();

  async function choose(next: ThemePreference): Promise<void> {
    if (next === theme) return;

    const previous = theme;
    setError(null);
    setTheme(next);
    // The repaint. One attribute, because every colour is a token.
    document.documentElement.setAttribute('data-theme', next);

    try {
      const response = await fetch('/api/account/theme', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // Same-origin: the route rejects a cross-origin request outright.
        body: JSON.stringify({ theme: next }),
      });

      if (!response.ok) throw new Error(String(response.status));
    } catch {
      // Put it back. A theme that looks saved and is not is worse than one that
      // visibly refused to change, because the next device disagrees.
      setTheme(previous);
      document.documentElement.setAttribute('data-theme', previous);
      setError('That did not save. Check your connection and try again.');
    }
  }

  return (
    <fieldset
      className="flex flex-col gap-3"
      aria-describedby={error ? `${groupId}-error` : undefined}
    >
      <legend className="text-h3 text-text">Theme</legend>
      <p className="text-body text-text-muted">
        Saved to your account, so it follows you to any device you sign in on.
      </p>

      <div className="mt-1 flex flex-col gap-2">
        {THEME_PREFERENCES.map((option) => {
          const id = `${groupId}-${option}`;
          const selected = theme === option;

          return (
            <label
              key={option}
              htmlFor={id}
              className={`duration-fast flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
                selected
                  ? 'border-signal bg-surface-2'
                  : 'border-line bg-surface-1 hover:border-line-strong'
              }`}
            >
              <input
                id={id}
                type="radio"
                name={groupId}
                value={option}
                checked={selected}
                disabled={pending}
                onChange={() => startTransition(() => void choose(option))}
                className="mt-1 accent-signal"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-body text-text">{THEME_PREFERENCE_LABELS[option]}</span>
                {/* Text, not only a swatch: a picker whose sole signal is
                    colour is unusable for the people most likely to need it. */}
                <span className="text-sm text-text-muted">
                  {THEME_PREFERENCE_DESCRIPTIONS[option]}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {error ? (
        // `role="alert"` so it is announced. A silent failure on a setting that
        // syncs across devices is how two machines end up disagreeing.
        <p id={`${groupId}-error`} role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
