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
    //
    // ⚠️ THE BAR WAS 20° AND growth-warm PASSED IT AT 27° WHILE BEING WRONG.
    // Dev log 0041 reported the collision and this test did not fail, because
    // 20° was picked when growth-warm was the only same-family pair and there
    // was nothing to calibrate against. Measured across all five themes, the
    // four with no collision separate by 62–103°, so the floor moved to 45 —
    // above growth-warm's old 27° and below every working theme. ADR-0060.
    const signal = tokens.get('color-signal')!;
    const attention = tokens.get('color-attention')!;
    const hueGap = Math.abs(signal[2] - attention[2]);
    expect(Math.min(hueGap, 360 - hueGap), 'signal and attention share a hue').toBeGreaterThan(45);
  });

  /**
   * ⚠️ THE SECOND CHECK EXISTS BECAUSE THE FIRST ONE IS A PROXY.
   *
   * Degrees of hue are not perceptually even: 27° of amber-against-amber
   * separates far less than 27° of amber-against-green, which is exactly how
   * growth-warm passed a hue rule while being the defect dev log 0041
   * reported. This measures the distance actually seen — Euclidean in Oklab,
   * the space these tokens are already authored in — so a future pair cannot
   * satisfy the angle and fail the eye again.
   *
   * The floor is 0.09. Measured: growth-warm 0.104, growth-bright 0.156,
   * growth-dark 0.179. growth-warm sits lowest because a light theme's status
   * colours must stay dark for 4.5:1 on cream, and sRGB caps chroma in the
   * dark warm band — a structural ceiling, recorded in ADR-0060 rather than
   * engineered around.
   */
  it('⚠️ the accent is PERCEPTUALLY distant from attention, not merely angled away', () => {
    const [sl, sc, sh] = tokens.get('color-signal')!;
    const [al, ac, ah] = tokens.get('color-attention')!;
    const toLab = (l: number, c: number, h: number): [number, number, number] => [
      l,
      c * Math.cos((h * Math.PI) / 180),
      c * Math.sin((h * Math.PI) / 180),
    ];
    const [l1, a1, b1] = toLab(sl, sc, sh);
    const [l2, a2, b2] = toLab(al, ac, ah);
    const distance = Math.hypot(l1 - l2, a1 - a2, b1 - b2);

    expect(distance, 'signal and attention are the same colour to the eye').toBeGreaterThan(0.09);
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
    // ⚠️ THE VIZ SEQUENCE, WHICH THIS LIST WAS MISSING WHILE THE BUG IT GUARDS
    // AGAINST WAS LIVE. The rationale below — "a theme that inherited a colour
    // from the dark base would pass a merged check while rendering a
    // dark-theme value on a light surface" — described the viz tokens exactly,
    // and they were not listed, so nothing failed. Dev logs 0039 to 0047
    // carried it as latent debt; measured, all six sat below 3:1 on all three
    // light canvases. ADR-0061.
    'color-viz-1',
    'color-viz-2',
    'color-viz-3',
    'color-viz-4',
    'color-viz-5',
    'color-viz-6',
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
 * ⚠️ THE DATA-VISUALISATION SEQUENCE, PER THEME.
 *
 * `design-system.md` promises "an ordered categorical sequence, chosen for
 * distinguishability under both common colour-vision deficiencies and
 * greyscale printing". Until ADR-0061 nothing asserted any part of that, and
 * measurement found the promise broken twice over:
 *
 *   - all six colours sat between 1.67:1 and 2.99:1 on all three LIGHT
 *     canvases — the entire sequence under 3:1, on three of five themes,
 *     because it was declared once against a dark canvas and never overridden;
 *   - and on the dark canvas where it did render, azure/violet separated by
 *     0.003 under red-green dichromacy and violet/rose by 0.007 in greyscale.
 *
 * The floors below are what the derived sequences actually achieve, minus a
 * small margin, so each is a real regression guard rather than an aspiration.
 * The light class sits closest to its floors: on a light canvas the 3:1
 * requirement caps how dark a series may be, which caps the greyscale spread
 * six series can occupy. That ceiling is recorded in ADR-0061, not engineered
 * around.
 */
const VIZ = [
  'color-viz-1',
  'color-viz-2',
  'color-viz-3',
  'color-viz-4',
  'color-viz-5',
  'color-viz-6',
] as const;

/** OKLCH → Oklab. The tokens are authored in the polar form of this space. */
function oklab([lightness, chroma, hue]: [number, number, number]): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

/** Perceptual distance, Euclidean in Oklab. */
function perceptualDistance(a: [number, number, number], b: [number, number, number]): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** What separates two colours once colour is removed entirely. */
function greyscaleGap(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(
    relativeLuminance(oklchToLinearSrgb(a)) - relativeLuminance(oklchToLinearSrgb(b)),
  );
}

const encodeSrgb = (u: number): number => {
  const c = Math.min(1, Math.max(0, u));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};
const decodeSrgb = (v: number): number => {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const RGB_TO_LMS = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
];
const LMS_TO_RGB = [
  [0.0809444479, -0.130504409, 0.116721066],
  [-0.0102485335, 0.0540193266, -0.113614708],
  [-0.000365296938, -0.00412161469, 0.693511405],
];
const apply = (m: number[][], v: number[]): number[] =>
  m.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!);

/**
 * Dichromacy simulation (Viénot, Brettel & Mollon), applied to GAMMA-ENCODED
 * sRGB, which is the form these particular LMS matrices are defined against.
 * Dev log 0047 discarded two earlier attempts for failing the validation the
 * first test below repeats — an unvalidated simulation would make every
 * assertion that uses it vacuous.
 */
function asDichromat(
  colour: [number, number, number],
  kind: 'protanopia' | 'deuteranopia',
): number[] {
  const lms = apply(RGB_TO_LMS, oklchToLinearSrgb(colour).map(encodeSrgb));
  const shifted =
    kind === 'protanopia'
      ? [2.02344 * lms[1]! - 2.52581 * lms[2]!, lms[1]!, lms[2]!]
      : [lms[0]!, 0.494207 * lms[0]! + 1.24827 * lms[2]!, lms[2]!];
  return apply(LMS_TO_RGB, shifted).map(decodeSrgb);
}

/** Linear sRGB → Oklab, for measuring what survives a simulation. */
function linearToOklab([r, g, b]: number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** The smaller of what a protanope and a deuteranope can still tell apart. */
function dichromatDistance(a: [number, number, number], b: [number, number, number]): number {
  const gap = (kind: 'protanopia' | 'deuteranopia'): number => {
    const [l1, a1, b1] = linearToOklab(asDichromat(a, kind));
    const [l2, a2, b2] = linearToOklab(asDichromat(b, kind));
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  };
  return Math.min(gap('protanopia'), gap('deuteranopia'));
}

describe('⚠️ the dichromacy simulation is itself checked before anything trusts it', () => {
  // Pure red and green, expressed in OKLCH.
  const red: [number, number, number] = [0.6279, 0.2577, 29.23];
  const green: [number, number, number] = [0.8664, 0.2948, 142.5];

  it('red and green lose most of their CHROMATIC difference', () => {
    const chromatic = (kind: 'protanopia' | 'deuteranopia'): number => {
      const [, a1, b1] = linearToOklab(asDichromat(red, kind));
      const [, a2, b2] = linearToOklab(asDichromat(green, kind));
      return Math.hypot(a1 - a2, b1 - b2);
    };
    const normal = Math.hypot(oklab(red)[1] - oklab(green)[1], oklab(red)[2] - oklab(green)[2]);

    // Not "goes to zero": a dichromat still separates red from green by
    // LIGHTNESS. It is the colour difference that collapses, and that is the
    // distinction dev log 0047 got wrong on its first two attempts.
    expect(chromatic('protanopia')).toBeLessThan(normal * 0.5);
    expect(chromatic('deuteranopia')).toBeLessThan(normal * 0.5);
  });

  it('leaves a blue/yellow difference largely intact', () => {
    const blue: [number, number, number] = [0.452, 0.3132, 264.05];
    const yellow: [number, number, number] = [0.9679, 0.211, 109.77];
    expect(dichromatDistance(blue, yellow)).toBeGreaterThan(0.3);
  });
});

/**
 * ⚠️ THE VIZ SEQUENCE MUST BE DECLARED `static`, OR IT DOES NOT SHIP.
 *
 * Tailwind v4 tree-shakes `@theme` variables that nothing references, and
 * nothing references these yet. Measured against a production build: with the
 * six declared in the ordinary `@theme` block, `--color-viz-*` appeared ZERO
 * times in the compiled stylesheet, so every theme resolved them to the empty
 * string. Dev logs 0039–0047 called this "light palettes inherit dark-tuned
 * chart colours"; in a real browser they inherited nothing at all.
 *
 * The four explicit `:root[data-theme=…]` blocks are never tree-shaken, so they
 * were never at risk. The dark base has no such block — the `@theme` block IS
 * the dark theme — which is why it alone needs `static`, and why moving these
 * declarations back into the ordinary block would silently delete them from the
 * build while every other test in this file stayed green.
 */
describe('⚠️ the dark viz sequence survives the build', () => {
  const staticBlock = (): string => {
    const start = css.indexOf('@theme static');
    expect(
      start,
      'no `@theme static` block — the dark viz sequence would be tree-shaken',
    ).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    return css.slice(open, css.indexOf('\n}', open));
  };

  it.each([...VIZ])('%s is declared inside `@theme static`', (token) => {
    expect(staticBlock()).toContain(`--${token}:`);
  });

  it('the ordinary `@theme` block does not declare them', () => {
    // Two declarations of the same token, one tree-shakeable, is how this
    // regresses without anything failing.
    const ordinary = css.slice(css.indexOf('@theme {'), css.indexOf('@theme static'));
    for (const token of VIZ)
      expect(ordinary, `--${token} is back in the tree-shakeable block`).not.toContain(
        `--${token}:`,
      );
  });
});

describe.each([
  ['dark', () => darkTokens],
  ['light', () => lightTokens],
  ['growth-bright', () => growthBrightTokens],
  ['growth-dark', () => growthDarkTokens],
  ['growth-warm', () => growthWarmTokens],
])('%s viz sequence', (_name, get) => {
  const swatches = (): [number, number, number][] =>
    VIZ.map((token) => {
      const value = get().get(token);
      if (!value) throw new Error(`--${token} missing from ${_name}`);
      return value;
    });

  it.each([...VIZ])('%s meets 3:1 against the canvas', (token) => {
    // WCAG 1.4.11: a graphical object carrying meaning needs 3:1, not 4.5:1.
    // This is the assertion the whole task existed for — every one of the six
    // failed it on all three light themes.
    expect(ratio(get(), token, 'color-canvas')).toBeGreaterThanOrEqual(3);
  });

  it('every pair is distinguishable in normal vision', () => {
    const all = swatches();
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(
          perceptualDistance(all[i]!, all[j]!),
          `viz-${i + 1} and viz-${j + 1} are the same colour`,
        ).toBeGreaterThan(0.12);
  });

  it('every pair survives red-green dichromacy', () => {
    const all = swatches();
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(
          dichromatDistance(all[i]!, all[j]!),
          `viz-${i + 1} and viz-${j + 1} collapse for a dichromat`,
        ).toBeGreaterThan(0.1);
  });

  it('every pair survives greyscale printing', () => {
    const all = swatches();
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(
          greyscaleGap(all[i]!, all[j]!),
          `viz-${i + 1} and viz-${j + 1} print as the same grey`,
        ).toBeGreaterThan(0.04);
  });

  it('no series can be mistaken for the ATTENTION colour', () => {
    // A chart series that looks like the warning colour misreports the data.
    const attention = get().get('color-attention')!;
    swatches().forEach((swatch, i) =>
      expect(
        perceptualDistance(swatch, attention),
        `viz-${i + 1} reads as the attention colour`,
      ).toBeGreaterThan(0.09),
    );
  });

  it('⚠️ only viz-1 may sit in the accent family', () => {
    // `design-system.md` names viz-1 "signal green" deliberately: a primary
    // series in the brand accent is intended. The other five are not, and a
    // second accent-coloured series would make the accent meaningless.
    const signal = get().get('color-signal')!;
    swatches()
      .slice(1)
      .forEach((swatch, i) =>
        expect(
          perceptualDistance(swatch, signal),
          `viz-${i + 2} reads as the accent`,
        ).toBeGreaterThan(0.09),
      );
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

/**
 * ⚠️ SIGNAL AGAINST ATTENTION UNDER RED-GREEN DICHROMACY — MEASURED, AND THE
 * REASON THE PRODUCT NO LONGER DEPENDS ON IT.
 *
 * Dev log 0047 measured this and recorded it without fixing it; 0048 carried it
 * forward unchanged. ADR-0062 closes it, and not by moving a colour: the search
 * showed there is no set of values that fixes all three Growth themes while they
 * remain the themes ADR-0057 describes. So the fix went to the one surface where
 * the pair carried meaning alone, and these assertions pin the measurement that
 * decision rests on.
 *
 * ⚠️ THE METRIC IS THE CHROMATIC COMPONENT, WHICH IS NOT WHAT `dichromatDistance`
 * ABOVE RETURNS. That function includes lightness, which is right for the viz
 * sequence — six series free to differ in lightness. It is wrong here: signal and
 * attention sit within 0.02 of each other in L in every theme, so there is no
 * lightness difference to fall back on and including it flatters the result. Dev
 * logs 0047 and 0048 both published chromatic numbers; the metric is validated
 * against ADR-0060's published inputs below before anything is asserted, because
 * the two metrics agree to within 1.31x where the pair survives and diverge by
 * up to 10.56x where it collapses.
 *
 * @see docs/decisions/ADR-0062-status-colour-is-never-the-only-carrier.md
 */
describe('⚠️ signal and attention under red-green dichromacy', () => {
  /** What a dichromat can still tell apart once lightness is excluded. */
  const chromaticGap = (
    a: [number, number, number],
    b: [number, number, number],
    kind: 'protanopia' | 'deuteranopia',
  ): number => {
    const [, a1, b1] = linearToOklab(asDichromat(a, kind));
    const [, a2, b2] = linearToOklab(asDichromat(b, kind));
    return Math.hypot(a1 - a2, b1 - b2);
  };

  const worst = (a: [number, number, number], b: [number, number, number]): number =>
    Math.min(chromaticGap(a, b, 'protanopia'), chromaticGap(a, b, 'deuteranopia'));

  const pair = (
    tokens: Map<string, [number, number, number]>,
  ): [[number, number, number], [number, number, number]] => [
    tokens.get('color-signal')!,
    tokens.get('color-attention')!,
  ];

  it('⚠️ the chromatic metric reproduces the number ADR-0060 published, from ADR-0060 inputs', () => {
    // The same validation discipline the simulation itself gets above, applied
    // to the metric built on it. `growth-warm` is the useful case because its
    // attention has MOVED since — hue 82 then, 105 now — so this cannot pass by
    // accidentally re-measuring today's file.
    const signalThen: [number, number, number] = [0.52, 0.128, 55];
    const attentionThen: [number, number, number] = [0.53, 0.108, 82];
    expect(chromaticGap(signalThen, attentionThen, 'protanopia')).toBeCloseTo(0.011, 3);
    expect(chromaticGap(signalThen, attentionThen, 'deuteranopia')).toBeCloseTo(0.005, 3);
  });

  it('⚠️ the two metrics AGREE where the pair survives and DIVERGE where it collapses', () => {
    // The negative that stops them being used interchangeably, and the reason
    // the choice is load-bearing rather than pedantic. Measured ratio of
    // `dichromatDistance` to the chromatic gap:
    //
    //   dark 1.28x · light 1.31x · growth-bright 3.78x · growth-warm 4.67x ·
    //   growth-dark 10.56x
    //
    // Where a real chromatic difference survives, the two metrics say nearly
    // the same thing. Where it does not, everything `dichromatDistance` still
    // reports is lightness — and signal and attention were never separated by
    // lightness on purpose, so reporting it flatters a pair that carries no
    // colour information at all.
    const ratio = (tokens: Map<string, [number, number, number]>): number => {
      const [signal, attention] = pair(tokens);
      return dichromatDistance(signal, attention) / worst(signal, attention);
    };

    for (const tokens of [darkTokens, lightTokens]) expect(ratio(tokens)).toBeLessThan(1.5);
    for (const [, tokens] of GROWTH_THEMES) expect(ratio(tokens)).toBeGreaterThan(3);
  });

  it.each([
    ['dark', () => darkTokens],
    ['light', () => lightTokens],
  ])('%s SURVIVES — its teal accent sits across the confusion axis, not along it', (_name, get) => {
    // The fact the whole comparison rests on. Hue 165 against a warm attention
    // is a blue-yellow difference, which dichromacy leaves largely intact; hue
    // 133–140 against the same attention is a red-green one, which it does not.
    const [signal, attention] = pair(get());
    expect(worst(signal, attention)).toBeGreaterThan(0.06);
  });

  it.each(GROWTH_THEMES)(
    '⚠️ %s COLLAPSES, and if this ever fails re-read ADR-0062 rather than deleting it',
    (_name, tokens) => {
      // Deliberately an upper bound, in the shape of the inverse-text assertion
      // above: it records a measured limitation rather than a target. Measured
      // today — growth-bright 0.002, growth-dark 0.003, growth-warm 0.008,
      // against 0.067 and 0.085 for the two themes that survive.
      //
      // A failure here means a palette change lifted a Growth theme across the
      // line, which is good news and makes ADR-0062's premise stale. The carrier
      // on the metric delta is still correct — it also serves screen-reader
      // users, who were in the same position with ordinary colour vision — but
      // the ADR's reasoning would need re-reading.
      const [signal, attention] = pair(tokens);
      expect(
        worst(signal, attention),
        'a Growth theme now separates signal from attention for a dichromat — re-read ADR-0062',
      ).toBeLessThan(0.05);
    },
  );

  it('⚠️ ONLY `dark` clears the standard the decorative viz sequence is held to', () => {
    // The measurement that made the carrier universal rather than Growth-only.
    // ADR-0061 requires every pair of CHART colours to separate by more than
    // 0.10 under dichromacy. The signal/attention pair carries far more meaning
    // than any chart series and four of five themes miss that bar — `light`
    // included, at 0.088. Colour alone was never sufficient anywhere except
    // `dark`, which is why the fix is a carrier and not a palette.
    const clears = ([, tokens]: [string, Map<string, [number, number, number]>]): boolean =>
      dichromatDistance(...pair(tokens)) > 0.1;

    const themes: [string, Map<string, [number, number, number]>][] = [
      ['dark', darkTokens],
      ['light', lightTokens],
      ...GROWTH_THEMES,
    ];

    expect(themes.filter(clears).map(([name]) => name)).toEqual(['dark']);
  });
});
