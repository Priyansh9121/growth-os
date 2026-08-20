/**
 * Class composition — and the collision that made a contrast rule decorative.
 *
 * WHY THIS FILE EXISTS
 * `cn` looked correct and was silently destructive. tailwind-merge knows
 * Tailwind's DEFAULT font-size scale; ours is bespoke, so it classified every
 * `text-*` as one group and let a size class delete a colour class. `Button`
 * composes variant-then-size, so the primary CTA lost `text-text-inverse` on
 * every screen in the product.
 *
 * Nothing caught it: the class was in the source, the component rendered, and
 * the only symptom was a low-contrast label. These tests assert the property
 * directly.
 *
 * @see docs/decisions/ADR-0058-dashboard-accent-emphasis.md
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cn, FONT_SIZE_STEPS } from './cn';

describe('a size class and a colour class are not the same conflict', () => {
  it('⚠️ keeps BOTH when a variant sets colour and a size sets font-size', () => {
    // The exact composition `Button` performs, in the exact order.
    const composed = cn(
      'bg-signal font-medium text-text-inverse shadow-sm hover:bg-signal-strong',
      'h-10 gap-2 rounded-md px-4 text-body',
    );

    // Before the fix this assertion failed: the colour was gone and the label
    // fell back to the inherited text colour on an accent fill.
    expect(composed, 'the accent CTA lost its label colour').toContain('text-text-inverse');
    expect(composed, 'the size step was dropped instead').toContain('text-body');
  });

  it.each(FONT_SIZE_STEPS)('text-%s does not delete a colour class', (step) => {
    const composed = cn('text-text-inverse', `text-${step}`);
    expect(composed).toContain('text-text-inverse');
    expect(composed).toContain(`text-${step}`);
  });

  it('a caller can still override the colour', () => {
    // The whole point of twMerge must survive the fix.
    expect(cn('text-text-inverse', 'text-text-muted')).toBe('text-text-muted');
  });

  it('a caller can still override the size', () => {
    expect(cn('text-body', 'text-caption')).toBe('text-caption');
  });

  it('ordinary conflicts still resolve last-one-wins', () => {
    expect(cn('px-4', 'px-6')).toBe('px-6');
    expect(cn('bg-signal', 'bg-critical')).toBe('bg-critical');
  });
});

describe('the font-size list matches the tokens', () => {
  it('⚠️ every --text-* step in tokens.css is named in FONT_SIZE_STEPS', () => {
    // The failure this prevents: someone adds `--text-hero`, uses `text-hero`
    // beside a colour class, and the colour silently disappears again. The
    // regression would be invisible in review and in every existing test.
    const tokensPath = resolve(dirname(fileURLToPath(import.meta.url)), '../tokens/tokens.css');
    const css = readFileSync(tokensPath, 'utf8');

    // Base steps only — `--text-h1--line-height` and friends are modifiers.
    const declared = new Set(
      [...css.matchAll(/^\s*--text-([a-z0-9-]+):/gm)]
        .map((match) => match[1]!)
        .filter((name) => !name.includes('--')),
    );

    expect(declared.size, 'no --text-* steps found; the parser is wrong').toBeGreaterThan(0);
    for (const step of declared) {
      expect(
        (FONT_SIZE_STEPS as readonly string[]).includes(step),
        `--text-${step} exists in tokens.css but is missing from FONT_SIZE_STEPS`,
      ).toBe(true);
    }
  });
});
