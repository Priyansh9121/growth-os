/**
 * The theme chooser — behaviour and accessibility.
 *
 * WHAT THESE PROTECT
 * Two things that are invisible when they break. First, that a failed save is
 * VISIBLY refused rather than silently kept: a theme that looks saved and is
 * not means the next device disagrees, and the user has no way to tell which
 * one is lying. Second, the accessibility commitments in
 * `docs/design/accessibility.md` — every option has a real label and a text
 * description, because a picker whose only signal is colour is unusable for
 * exactly the people most likely to be changing it.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  THEME_PREFERENCES,
  THEME_PREFERENCE_DESCRIPTIONS,
  THEME_PREFERENCE_LABELS,
  type ThemePreference,
} from '@growth-os/contracts';
import { ThemeSetting } from './theme-setting';

const ok = () => Promise.resolve({ ok: true, status: 200 } as Response);
const boom = () => Promise.resolve({ ok: false, status: 500 } as Response);

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.setAttribute('data-theme', 'dark');
});

/**
 * ⚠️ SELECTED BY VALUE, NOT BY ACCESSIBLE NAME.
 *
 * These read `getByRole('radio', { name: /dark/i })` while there were two
 * themes. With five that is ambiguous twice over: `/dark/i` matches both "Dark"
 * and "Growth Dark", and anchoring to `^Growth\b` matches all three Growth
 * themes. The value attribute is the theme id, so it is exact by construction.
 *
 * The accessible NAME is then asserted separately, as its own property, rather
 * than being load-bearing for finding the element — which is what made the
 * original queries fragile the moment a fifth option arrived.
 */
const radio = (theme: ThemePreference): HTMLInputElement => {
  const found = screen
    .getAllByRole('radio')
    .find((element): element is HTMLInputElement => (element as HTMLInputElement).value === theme);
  if (!found) throw new Error(`No radio with value "${theme}"`);
  return found;
};

describe('theme chooser', () => {
  it('offers EVERY theme as a labelled radio, with a description', () => {
    render(<ThemeSetting initialTheme="dark" />);

    // Driven off the vocabulary rather than a hand-written list, so adding a
    // sixth theme without a label or description fails here rather than
    // shipping a radio nobody can identify.
    expect(screen.getAllByRole('radio')).toHaveLength(THEME_PREFERENCES.length);

    for (const theme of THEME_PREFERENCES) {
      const name = radio(theme).labels?.[0]?.textContent ?? '';
      // Both halves. Descriptions are part of the accessible name so a screen
      // reader user hears what the choice MEANS, not just its colour word —
      // which matters more with five themes than two, since "Growth" and
      // "Growth Dark" are not tellable apart by name alone.
      expect(name, `${theme} is missing its label`).toContain(THEME_PREFERENCE_LABELS[theme]);
      expect(name, `${theme} is missing its description`).toContain(
        THEME_PREFERENCE_DESCRIPTIONS[theme],
      );
    }

    // Every label is distinct, which is what the query above can no longer
    // prove for us now that it selects by value.
    const labels = THEME_PREFERENCES.map((theme) => THEME_PREFERENCE_LABELS[theme]);
    expect(new Set(labels).size, 'two themes share a label').toBe(labels.length);

    expect(radio('dark')).toBeChecked();
    expect(radio('light')).not.toBeChecked();
  });

  it('reflects the stored theme, not the document', () => {
    // The server passes what is STORED. If this read the DOM instead, the
    // control would agree with the page even when the page was wrong.
    render(<ThemeSetting initialTheme="light" />);
    expect(radio('light')).toBeChecked();
  });

  it.each(THEME_PREFERENCES)('can switch to %s', async (theme) => {
    // Every one of the five is reachable, not just the two that existed first.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok);
    const user = userEvent.setup();
    // Start somewhere else so the click is always a real change.
    const start = theme === 'dark' ? 'light' : 'dark';
    render(<ThemeSetting initialTheme={start} />);

    await user.click(radio(theme));

    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe(theme));
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ theme });
  });

  it('⚠️ repaints immediately and persists the choice', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok);
    const user = userEvent.setup();
    render(<ThemeSetting initialTheme="dark" />);

    await user.click(radio('light'));

    // The repaint is one attribute, because every colour is a token.
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('light'));

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/account/theme');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ theme: 'light' });
  });

  it('⚠️ REVERTS and says so when the save fails', async () => {
    // The property that matters. Keeping the new theme on a failed write is
    // how a browser and an account end up disagreeing permanently.
    vi.spyOn(globalThis, 'fetch').mockImplementation(boom);
    const user = userEvent.setup();
    render(<ThemeSetting initialTheme="dark" />);

    await user.click(radio('light'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(radio('dark')).toBeChecked();
  });

  it('reverts on a network error too, not only on a bad status', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<ThemeSetting initialTheme="dark" />);

    await user.click(radio('light'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('does not send a request when the chosen theme is already current', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok);
    const user = userEvent.setup();
    render(<ThemeSetting initialTheme="dark" />);

    await user.click(radio('dark'));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
