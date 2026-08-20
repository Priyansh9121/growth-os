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

// The `@theme` block — the dark theme, and the base every other theme layers on.
const baseTokens = parseTokens(css.slice(0, css.indexOf(":root[data-theme='light']")));

/**
 * The tokens in force for one theme: the `@theme` base, overridden by that
 * theme's own block.
 *
 * ⚠️ THE BLOCK IS EXTRACTED EXACTLY, NOT SLICED TO END-OF-FILE.
 * This read `css.slice(blockStart)` and relied on first-definition-wins, which
 * worked only while the light theme was the LAST block in the file. With five
 * themes that approach silently attributes a later theme's tokens to an earlier
 * one — every theme would appear to define every token, and the integrity test
 * below could never fail again. Reading to the block's closing brace is what
 * keeps it a real check.
 */
function themeTokens(selector: string): Map<string, [number, number, number]> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No block for ${selector} in tokens.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  if (open === -1 || close === -1) throw new Error(`Unterminated block for ${selector}`);

  // A theme block OVERRIDES the base; anything it does not name is inherited,
  // which is exactly what the cascade does at runtime.
  return new Map([...baseTokens, ...parseTokens(css.slice(open, close))]);
}

/** The raw text of one theme block, for assertions about what it declares. */
function ownBlock(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No block for ${selector} in tokens.css`);
  const open = css.indexOf('{', start);
  return css.slice(open, css.indexOf('\n}', open));
}

/** What a theme block defines ITSELF, for the integrity check. */
function ownTokens(selector: string): Map<string, [number, number, number]> {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  return parseTokens(css.slice(open, close));
}

const darkTokens = baseTokens;
const lightTokens = themeTokens(":root[data-theme='light']");
const growthBrightTokens = themeTokens(":root[data-theme='growth-bright']");
const growthDarkTokens = themeTokens(":root[data-theme='growth-dark']");
const growthWarmTokens = themeTokens(":root[data-theme='growth-warm']");

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

/**
 * The three Growth palettes, held to exactly the bar the two above already
 * meet — no stricter, no looser.
 *
 * ⚠️ THESE WERE DESIGNED AGAINST THIS GATE, NOT CHECKED AFTERWARDS. Every
 * accent here was chosen by computing the ratio first: the reviewed sketch's
 * mid-green measured 3.2:1 on its own surface and was darkened until it
 * cleared 4.5:1, which is the same trade the light theme made.
 *
 * @see docs/decisions/ADR-0057-growth-theme-palettes.md
 */
const GROWTH_THEMES: readonly [string, Map<string, [number, number, number]>][] = [
  ['growth-bright', growthBrightTokens],
  ['growth-dark', growthDarkTokens],
  ['growth-warm', growthWarmTokens],
];

describe.each(GROWTH_THEMES)('%s theme contrast', (_name, tokens) => {
  it.each([
    ['color-text', 'color-canvas'],
    ['color-text', 'color-surface-1'],
    ['color-text', 'color-surface-2'],
    ['color-text', 'color-surface-3'],
  ])('%s on %s meets 4.5:1 for body text', (foreground, background) => {
    expect(ratio(tokens, foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['color-text-muted', 'color-canvas'],
    ['color-text-muted', 'color-surface-1'],
    ['color-text-muted', 'color-surface-2'],
  ])('%s on %s meets 4.5:1 — secondary text is still text', (foreground, background) => {
    expect(ratio(tokens, foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the accent holds 4.5:1 on the canvas and on surface-1', () => {
    // An energetic palette that cannot be read is not a usable palette. This
    // is the assertion that forced every Growth accent darker than its sketch.
    expect(ratio(tokens, 'color-signal', 'color-canvas')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tokens, 'color-signal', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
  });

  it('status colours meet 4.5:1 on surfaces', () => {
    expect(ratio(tokens, 'color-attention', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tokens, 'color-critical', 'color-surface-1')).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring meets 3:1 against the canvas', () => {
    expect(ratio(tokens, 'color-signal', 'color-canvas')).toBeGreaterThanOrEqual(3);
  });

  it('tertiary text meets 3:1 (large/incidental use only)', () => {
    expect(ratio(tokens, 'color-text-subtle', 'color-canvas')).toBeGreaterThanOrEqual(3);
  });

  it('⚠️ the accent is distinguishable from the status colours', () => {
    // Specific to these palettes and not inherited from the two above. In a
    // warm theme the accent and `attention` are drawn from the same family, so
    // "this is working" and "look at this" can collapse into one colour. A
    // status colour indistinguishable from the accent is not a status colour.
    const signal = tokens.get('color-signal')!;
    const attention = tokens.get('color-attention')!;
    const hueGap = Math.abs(signal[2] - attention[2]);
    expect(Math.min(hueGap, 360 - hueGap), 'signal and attention share a hue').toBeGreaterThan(20);
  });
});

/**
 * ⚠️ THE SOLID ACCENT FILL — every theme, and it had never been checked.
 *
 * `Button`'s primary variant is `bg-signal text-text-inverse`, which its own
 * comment justifies on contrast grounds. Nothing verified it. It was also not
 * even applying: `cn` was deleting the colour class (see `lib/cn.test.ts`), so
 * the label rendered in `--color-text` at 1.47:1 in growth-dark and 2.83:1 in
 * growth-bright.
 *
 * Both halves are now pinned — that the intended pair is readable, and that the
 * pair actually reaching the DOM is the intended one.
 */
describe('the solid accent fill is readable in every theme', () => {
  it.each([
    ['dark', () => darkTokens],
    ['light', () => lightTokens],
    ['growth-bright', () => growthBrightTokens],
    ['growth-dark', () => growthDarkTokens],
    ['growth-warm', () => growthWarmTokens],
  ])('%s: inverse text on the accent fill meets 4.5:1', (_name, get) => {
    expect(ratio(get(), 'color-text-inverse', 'color-signal')).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['dark', () => darkTokens],
    ['light', () => lightTokens],
    ['growth-bright', () => growthBrightTokens],
    ['growth-dark', () => growthDarkTokens],
    ['growth-warm', () => growthWarmTokens],
  ])('%s: the ORDINARY text colour on that fill would NOT be readable', (_name, get) => {
    // The negative that gives the assertion above its meaning. If this ever
    // passes, `text-text-inverse` has stopped being load-bearing and the
    // measurement that motivated ADR-0058 no longer applies.
    expect(
      ratio(get(), 'color-text', 'color-signal'),
      'ordinary text on the accent is now readable — re-check whether the inverse is still needed',
    ).toBeLessThan(4.5);
  });
});

/** Every explicit theme block in the file, by name and selector. */
const THEME_SELECTORS: readonly [string, string][] = [
  ['light', ":root[data-theme='light']"],
  ['growth-bright', ":root[data-theme='growth-bright']"],
  ['growth-dark', ":root[data-theme='growth-dark']"],
  ['growth-warm', ":root[data-theme='growth-warm']"],
];

describe('token integrity', () => {
  const REQUIRED = [
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

  it.each(THEME_SELECTORS)('%s defines every semantic colour ITSELF', (_name, selector) => {
    // ⚠️ `ownTokens`, not the merged view. A theme that inherited a colour from
    // the dark base would pass a merged check while rendering a dark-theme
    // value on a light surface — which is precisely the bug this guards.
    const own = ownTokens(selector);
    for (const token of REQUIRED) {
      expect(own.has(token), `${_name} does not define --${token}`).toBe(true);
    }
  });

  it('the dark base defines every semantic colour', () => {
    for (const token of REQUIRED) {
      expect(darkTokens.has(token), `dark theme missing --${token}`).toBe(true);
    }
  });
});

/**
 * ⚠️ THE CASCADE, WHICH EVERY OTHER TEST IN THIS FILE IS BLIND TO.
 *
 * Everything above reads token VALUES out of a block. That cannot catch a
 * selector which silently overrides a whole block — and one did: the
 * `prefers-color-scheme: light` guard was written `:root:not([data-theme='dark'])`,
 * which has the same specificity as `:root[data-theme='growth-bright']` and sits
 * later in the file. On any machine whose OS prefers light, all three Growth
 * themes rendered as the plain Light theme and `growth-dark` rendered LIGHT.
 *
 * The whole suite was green throughout, because the values were right and only
 * the cascade was wrong. Found by opening a browser (dev log 0040).
 *
 * A browser is the only place the real cascade can be observed, and the e2e
 * suite is not in `verify:all`. So this pins the property statically, in the
 * fast gate: a preference guard must key on the ABSENCE of `data-theme`, never
 * on it not equalling one particular value.
 */
describe('⚠️ OS-preference guards cannot override an explicit theme', () => {
  const guards = [...css.matchAll(/@media\s*\(prefers-color-scheme[^)]*\)\s*\{/g)].map((match) => {
    const after = css.slice(match.index! + match[0].length);
    // The first selector inside the media block.
    return after.slice(0, after.indexOf('{')).trim();
  });

  it('there is at least one guard to check', () => {
    // Otherwise the assertions below would vacuously pass after a refactor.
    expect(guards.length).toBeGreaterThan(0);
  });

  it.each(guards)('`%s` keys on attribute absence, not on a value', (guard) => {
    expect(guard).toContain(':not([data-theme]');
    // The exact shape that broke three themes. `:not([data-theme='x'])` matches
    // every OTHER theme, which is the opposite of what the block means.
    expect(guard, 'a value-specific negation matches every other theme').not.toMatch(
      /:not\(\[data-theme=['"]/,
    );
  });

  it.each(THEME_SELECTORS)('%s is not overridden by an OS-preference guard', (_name, selector) => {
    // Source order plus equal specificity is what did the damage, so assert the
    // guard cannot match the theme at all rather than relying on ordering.
    const themeValue = selector.match(/data-theme='([^']+)'/)![1]!;
    for (const guard of guards) {
      const negated = guard.match(/:not\(\[data-theme=['"]([^'"]+)['"]\]\)/)?.[1];
      expect(
        negated !== undefined && negated !== themeValue,
        `the guard \`${guard}\` matches [data-theme='${themeValue}'] and would override it`,
      ).toBe(false);
    }
  });
});

/**
 * ⚠️ DARK AND LIGHT MUST NOT GAIN THE DASHBOARD'S ACCENT EMPHASIS.
 *
 * ADR-0057 keeps Dark and Light as the deliberately quiet option; ADR-0058
 * spends more accent on dashboard stat cards and applies to the three Growth
 * themes ONLY. That split is a promise about how the product looks, so it is
 * asserted rather than left to whoever edits `tokens.css` next.
 *
 * The mechanism is two tokens, off in the base and on in the Growth blocks —
 * no `theme === '…'` branch exists in any component, which is why this file can
 * verify the whole rule.
 */
describe('accent emphasis is opt-in, and only the Growth themes opt in', () => {
  const EMPHASIS = ['color-metric-emphasis', 'color-card-accent'];

  it.each(EMPHASIS)('%s is declared in the base theme', (token) => {
    // Declared centrally so a theme that says nothing inherits "off" rather
    // than inheriting nothing and rendering an unset colour.
    expect(css.slice(0, css.indexOf(":root[data-theme='light']"))).toContain(`--${token}:`);
  });

  it.each([
    ['growth-bright', ":root[data-theme='growth-bright']"],
    ['growth-dark', ":root[data-theme='growth-dark']"],
    ['growth-warm', ":root[data-theme='growth-warm']"],
  ])('%s turns emphasis ON', (_name, selector) => {
    const own = ownBlock(selector);
    for (const token of EMPHASIS) {
      expect(own, `${_name} does not enable --${token}`).toContain(
        `--${token}: var(--color-signal)`,
      );
    }
  });

  it.each([['light', ":root[data-theme='light']"]])(
    '⚠️ %s does NOT turn emphasis on — its restraint is the point',
    (_name, selector) => {
      const own = ownBlock(selector);
      for (const token of EMPHASIS) {
        expect(
          own,
          `${_name} started emphasising the accent (ADR-0057 says it should not)`,
        ).not.toContain(`--${token}`);
      }
    },
  );

  it('⚠️ the base (Dark) resolves emphasis to ordinary text, not to the accent', () => {
    // Dark inherits the base declarations. If someone "helpfully" pointed the
    // base at --color-signal, Dark would silently gain the Growth treatment —
    // the exact change ADR-0057 says must not happen to it.
    const base = css.slice(0, css.indexOf(":root[data-theme='light']"));
    expect(base).toContain('--color-metric-emphasis: var(--color-text)');
    expect(base).toContain('--color-card-accent: transparent');
  });
});
