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

describe('theme chooser', () => {
  it('offers every theme as a labelled radio, with a description', () => {
    render(<ThemeSetting initialTheme="dark" />);

    const dark = screen.getByRole('radio', { name: /dark/i });
    const light = screen.getByRole('radio', { name: /light/i });

    expect(dark).toBeChecked();
    expect(light).not.toBeChecked();
    // Descriptions are part of the accessible name, so a screen reader user
    // hears what the choice means rather than just its colour word.
    expect(dark).toHaveAccessibleName(/graphite|long sessions/i);
  });

  it('reflects the stored theme, not the document', () => {
    // The server passes what is STORED. If this read the DOM instead, the
    // control would agree with the page even when the page was wrong.
    render(<ThemeSetting initialTheme="light" />);
    expect(screen.getByRole('radio', { name: /light/i })).toBeChecked();
  });

  it('⚠️ repaints immediately and persists the choice', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok);
    const user = userEvent.setup();
    render(<ThemeSetting initialTheme="dark" />);

    await user.click(screen.getByRole('radio', { name: /light/i }));

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

    await user.click(screen.getByRole('radio', { name: /light/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(screen.getByRole('radio', { name: /dark/i })).toBeChecked();
  });

  it('reverts on a network error too, not only on a bad status', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<ThemeSetting initialTheme="dark" />);

    await user.click(screen.getByRole('radio', { name: /light/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('does not send a request when the chosen theme is already current', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok);
    const user = userEvent.setup();
    render(<ThemeSetting initialTheme="dark" />);

    await user.click(screen.getByRole('radio', { name: /dark/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
