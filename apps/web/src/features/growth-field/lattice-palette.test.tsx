/**
 * The 3D scene follows the theme — the claim ADR-0056 §4 makes, proven.
 *
 * WHY THIS TEST EXISTS
 * Adding a theme switch raises an obvious question: does the WebGL lattice
 * break, or silently keep dark colours, when the palette changes? The answer is
 * that it needs no change at all — `readPalette` reads its four colours from
 * CSS custom properties at runtime, and the light theme redefines all four.
 *
 * That is a claim about wiring, and wiring is exactly what rots quietly. If
 * someone later hard-codes a hex value into the scene "just for the canvas
 * colour", the lattice stops following the theme and nothing looks broken in
 * the theme they developed in. This fails instead.
 *
 * ⚠️ WHAT IT DOES NOT PROVE. jsdom does not apply `tokens.css`, so this cannot
 * assert that the light theme's specific values reach the scene. It proves the
 * mechanism: the scene reads these four variable NAMES from computed style, so
 * whatever the cascade resolves them to is what the scene draws.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { describe, expect, it } from 'vitest';
import { readPalette } from './lattice-geometry';

/** The four tokens the light theme redefines and the scene consumes. */
type ThemedToken = '--color-signal' | '--color-signal-dim' | '--color-attention' | '--color-canvas';

function elementWith(values: Partial<Record<ThemedToken, string>>): HTMLElement {
  const element = document.createElement('div');
  for (const [name, value] of Object.entries(values)) {
    element.style.setProperty(name, value);
  }
  document.body.appendChild(element);
  return element;
}

describe('readPalette', () => {
  it('⚠️ reads all four colours from CSS custom properties, not from constants', () => {
    // Deliberately absurd values: a hard-coded palette would return the real
    // dark-theme colours and this would fail.
    const element = elementWith({
      '--color-signal': 'rgb(1, 2, 3)',
      '--color-signal-dim': 'rgb(4, 5, 6)',
      '--color-attention': 'rgb(7, 8, 9)',
      '--color-canvas': 'rgb(10, 11, 12)',
    });

    expect(readPalette(element)).toEqual({
      signal: 'rgb(1, 2, 3)',
      signalDim: 'rgb(4, 5, 6)',
      attention: 'rgb(7, 8, 9)',
      canvas: 'rgb(10, 11, 12)',
    });
  });

  it('follows a theme change, because the variables are what changed', () => {
    // What a data-theme switch does to the cascade, simulated at one element:
    // the same four names now resolve to different values, and the scene gets
    // the new ones with no code path of its own.
    const dark = elementWith({ '--color-canvas': 'oklch(0.145 0.012 255)' });
    const light = elementWith({ '--color-canvas': 'oklch(0.985 0.002 255)' });

    expect(readPalette(dark).canvas).toBe('oklch(0.145 0.012 255)');
    expect(readPalette(light).canvas).toBe('oklch(0.985 0.002 255)');
  });

  it('falls back to the dark values when a token is missing', () => {
    // Before styles resolve, or on a surface that never loaded the tokens.
    // A blank string would paint the lattice invisible.
    const palette = readPalette(elementWith({}));

    for (const value of Object.values(palette)) {
      expect(value.length).toBeGreaterThan(0);
    }
    expect(palette.canvas).toContain('oklch');
  });
});
