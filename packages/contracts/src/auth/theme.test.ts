/**
 * The signed-out palette is pinned, and stays pinned.
 *
 * WHAT THESE TESTS ARE FOR
 * `SIGNED_OUT_THEME` and `DEFAULT_THEME_PREFERENCE` hold the same value today.
 * That makes the property worth protecting invisible at runtime: every
 * equality assertion anyone could write passes either way, including the
 * broken way. So the independence is checked at the SOURCE, where the
 * difference between a literal and an alias is actually observable.
 *
 * @see docs/decisions/ADR-0059-signed-out-theme-is-pinned.md
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  SIGNED_OUT_THEME,
  THEME_PREFERENCES,
  type ThemePreference,
} from './theme';

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'theme.ts'), 'utf8');

/** The declaration's right-hand side, as written — not as evaluated. */
function declaredValueOf(constant: string): string {
  const match = source.match(new RegExp(`export const ${constant}[^=]*=\\s*([^;]+);`));
  expect(match, `${constant} is not declared in theme.ts`).not.toBeNull();
  return match![1]!.trim();
}

describe('SIGNED_OUT_THEME', () => {
  /**
   * The literal, not the constant compared to itself. `expect(SIGNED_OUT_THEME)
   * .toBe(SIGNED_OUT_THEME)` passes whatever the constant becomes, which is the
   * same trap `packages/auth`'s preference tests document.
   */
  it('is growth-bright', () => {
    expect(SIGNED_OUT_THEME).toBe('growth-bright');
  });

  it('is a member of the one theme vocabulary', () => {
    expect(THEME_PREFERENCES).toContain(SIGNED_OUT_THEME);
  });

  /**
   * ⚠️ THE LOAD-BEARING TEST. Everything else here passes just as happily if a
   * later session "simplifies" this to `SIGNED_OUT_THEME =
   * DEFAULT_THEME_PREFERENCE`, which would silently restore the coupling
   * ADR-0059 removed: changing the account default would restyle the login
   * page again, and no runtime assertion in this repository could tell.
   */
  it('is declared as its own literal, never as an alias of the account default', () => {
    const declared = declaredValueOf('SIGNED_OUT_THEME');

    expect(declared).not.toContain('DEFAULT_THEME_PREFERENCE');
    expect(declared).toMatch(/^'[a-z-]+'$/);
  });

  /** And not the other way round either. Either alias recreates the coupling. */
  it('is not the value DEFAULT_THEME_PREFERENCE is aliased to', () => {
    const declared = declaredValueOf('DEFAULT_THEME_PREFERENCE');

    expect(declared).not.toContain('SIGNED_OUT_THEME');
    expect(declared).toMatch(/^'[a-z-]+'$/);
  });

  /**
   * The two are allowed to be equal — they are today, deliberately, so the pin
   * changed no pixels. What must never happen is one MOVING because the other
   * did. This records the current relationship so that a session changing the
   * account default sees this assertion in its diff and has to decide about the
   * logged-out surface on purpose.
   */
  it('happens to equal the account default today, as a recorded coincidence', () => {
    expect(SIGNED_OUT_THEME).toBe('growth-bright');
    expect(DEFAULT_THEME_PREFERENCE).toBe('growth-bright');
  });
});

describe('the theme vocabulary is still singular', () => {
  it('has no duplicate entries', () => {
    expect(new Set(THEME_PREFERENCES).size).toBe(THEME_PREFERENCES.length);
  });

  it('types both pinned constants from the same union', () => {
    const themes: ThemePreference[] = [SIGNED_OUT_THEME, DEFAULT_THEME_PREFERENCE];
    for (const theme of themes) expect(THEME_PREFERENCES).toContain(theme);
  });
});
