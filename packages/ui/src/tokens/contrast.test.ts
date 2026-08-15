/**
 * Colour contrast — a build gate, not a claim.
 *
 * WHY THIS EXISTS
 * `docs/design/design-system.md` asserts specific contrast ratios. An
 * assertion in a document is not a control: someone adjusts a token to make a
 * surface look better, contrast drops below 4.5:1, and nobody notices because
 * nothing appears broken. This suite parses the real token values out of
 * `tokens.css` and computes actual WCAG ratios, so the claim is enforced.
 *
 * The OKLCH → sRGB conversion is implemented here rather than pulled from a
 * dependency: it is ~40 lines of well-specified maths, and adding a colour
 * library to the dependency graph for a test would fail our own dependency
 * policy.
 *
 * @see docs/design/design-system.md §1
 * @see docs/engineering/dependency-policy.md
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokensPath = resolve(dirname(fileURLToPath(import.meta.url)), 'tokens.css');
const css = readFileSync(tokensPath, 'utf8');

/** Extract `--name: oklch(L C H)` declarations from a CSS block. */
function parseTokens(source: string): Map<string, [number, number, number]> {
  const tokens = new Map<string, [number, number, number]>();
  const pattern = /--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const [, name, lightness, chroma, hue] = match;
    if (!name || !lightness || !chroma || !hue) continue;
    // First definition wins: the `@theme` block (dark theme) precedes the
    // light-theme overrides in the file.
    if (!tokens.has(name)) {
      tokens.set(name, [Number(lightness), Number(chroma), Number(hue)]);
    }
  }

  return tokens;
}

/** OKLCH → linear sRGB, per the Oklab specification. */
function oklchToLinearSrgb([lightness, chroma, hue]: [number, number, number]): [
  number,
  number,
  number,
] {
  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** WCAG 2.1 relative luminance. Linear sRGB needs no further linearisation. */
function relativeLuminance(colour: [number, number, number]): number {
  const [r, g, b] = colour.map((channel) => Math.min(1, Math.max(0, channel))) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(
  foreground: [number, number, number],
  background: [number, number, number],
): number {
  const a = relativeLuminance(oklchToLinearSrgb(foreground));
  const b = relativeLuminance(oklchToLinearSrgb(background));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

const darkTokens = parseTokens(css);

// The light theme is defined after the dark one, so parse from that point on.
const lightBlockStart = css.indexOf(":root[data-theme='light']");
const lightTokens = parseTokens(css.slice(lightBlockStart));

function ratio(tokens: Map<string, [number, number, number]>, fg: string, bg: string): number {
  const foreground = tokens.get(fg);
  const background = tokens.get(bg);
  if (!foreground) throw new Error(`Token --${fg} not found or not in oklch() form`);
  if (!background) throw new Error(`Token --${bg} not found or not in oklch() form`);
  return contrastRatio(foreground, background);
}

describe('dark theme contrast', () => {
  it.each([
    ['color-text', 'color-canvas'],
    ['color-text', 'color-surface-1'],
    ['color-text', 'color-surface-2'],
    ['color-text', 'color-surface-3'],
  ])('%s on %s meets 4.5:1 for body text', (foreground, background) => {
    expect(ratio(darkTokens, foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['color-text-muted', 'color-canvas'],
    ['color-text-muted', 'color-surface-1'],
    ['color-text-muted', 'color-surface-2'],
  ])('%s on %s meets 4.5:1 — secondary text is still text', (foreground, background) => {
    expect(ratio(darkTokens, foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('signal accent meets 4.5:1 on every surface it is used as text on', () => {
    expect(ratio(darkTokens, 'color-signal', 'color-canvas')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(darkTokens, 'color-signal', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
  });

  it('status colours meet 4.5:1 on surfaces', () => {
    expect(ratio(darkTokens, 'color-attention', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(darkTokens, 'color-critical', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring meets 3:1 against the canvas', () => {
    // WCAG 2.1 SC 1.4.11: a focus indicator is a non-text element that
    // conveys state, so it needs 3:1 — an invisible focus ring is a keyboard
    // trap for anyone who cannot see where they are.
    expect(ratio(darkTokens, 'color-signal', 'color-canvas')).toBeGreaterThanOrEqual(3);
  });

  it('tertiary text meets 3:1 (large/incidental use only)', () => {
    // Documented as suitable for large text and metadata, never body copy.
    expect(ratio(darkTokens, 'color-text-subtle', 'color-canvas')).toBeGreaterThanOrEqual(3);
  });
});

describe('light theme contrast', () => {
  it.each([
    ['color-text', 'color-canvas'],
    ['color-text', 'color-surface-1'],
    ['color-text', 'color-surface-2'],
  ])('%s on %s meets 4.5:1', (foreground, background) => {
    expect(ratio(lightTokens, foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('muted text meets 4.5:1', () => {
    expect(ratio(lightTokens, 'color-text-muted', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
  });

  it('the darkened signal accent holds 4.5:1 on white', () => {
    // The whole reason light is a re-mapping rather than an inversion: the
    // dark theme's bright mint would fail badly on a white surface.
    expect(ratio(lightTokens, 'color-signal', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
  });

  it('status colours meet 4.5:1', () => {
    expect(ratio(lightTokens, 'color-critical', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(lightTokens, 'color-attention', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('token integrity', () => {
  it('defines every semantic colour in both themes', () => {
    // A token present in one theme and missing in the other renders as
    // `unset` — usually black on black — and only in the theme nobody
    // developed in.
    const required = [
      'color-canvas',
      'color-surface-1',
      'color-surface-2',
      'color-surface-3',
      'color-line',
      'color-line-strong',
      'color-text',
      'color-text-muted',
      'color-text-subtle',
      'color-signal',
      'color-attention',
      'color-critical',
    ];

    for (const token of required) {
      expect(darkTokens.has(token), `dark theme missing --${token}`).toBe(true);
      expect(lightTokens.has(token), `light theme missing --${token}`).toBe(true);
    }
  });
});
