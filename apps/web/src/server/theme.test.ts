/**
 * The signed-out surface follows the PIN, not the account default.
 *
 * WHY THIS TEST EXISTS
 * `SIGNED_OUT_THEME` and `DEFAULT_THEME_PREFERENCE` hold the same string today,
 * so reverting this module to the old constant changes nothing observable and
 * every naive assertion keeps passing. These tests break that symmetry: the
 * contracts module is mocked so the two constants DISAGREE, which makes "which
 * one does the resolver actually read" a question with a visible answer.
 *
 * `packages/contracts` owns the companion check that the constants are declared
 * independently. This owns the check that the web app is wired to the right one.
 *
 * @see docs/decisions/ADR-0059-signed-out-theme-is-pinned.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
// A named type import, not `typeof import(...)` inline: the repository forbids
// `import()` type annotations (@typescript-eslint/consistent-type-imports).
import type * as Contracts from '@growth-os/contracts';

/**
 * Deliberately NOT the real values. If the resolver reads the account default
 * anywhere it is supposed to read the pin, the assertion says `'dark'` where it
 * wanted `'growth-warm'` — instead of passing because both said
 * `'growth-bright'`.
 */
const PINNED = 'growth-warm';
const ACCOUNT_DEFAULT = 'dark';

vi.mock('@growth-os/contracts', async (importOriginal) => ({
  ...(await importOriginal<typeof Contracts>()),
  SIGNED_OUT_THEME: PINNED,
  DEFAULT_THEME_PREFERENCE: ACCOUNT_DEFAULT,
}));

const cookieValue = vi.fn<() => string | undefined>();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_name: string) => ({ value: cookieValue() }) }),
}));

const validateSession = vi.fn();
const getThemePreference = vi.fn();
vi.mock('@growth-os/auth', () => ({
  SESSION_COOKIE_NAME: 'gos_session',
  validateSession: (...args: unknown[]) => validateSession(...args),
  getThemePreference: (...args: unknown[]) => getThemePreference(...args),
}));

const getDependencies = vi.fn();
vi.mock('./dependencies', () => ({ getDependencies: () => getDependencies() }));

const { resolveRequestTheme } = await import('./theme');

beforeEach(() => {
  vi.clearAllMocks();
  getDependencies.mockReturnValue({ db: {}, sessionConfig: {} });
});

describe('resolveRequestTheme — signed out', () => {
  it('renders the pinned palette when there is no session cookie', async () => {
    cookieValue.mockReturnValue(undefined);

    await expect(resolveRequestTheme()).resolves.toBe(PINNED);
  });

  it('renders the pinned palette when the cookie is present but invalid', async () => {
    cookieValue.mockReturnValue('a-stale-or-forged-token');
    validateSession.mockResolvedValue(null);

    await expect(resolveRequestTheme()).resolves.toBe(PINNED);
  });

  /**
   * ⚠️ THE REGRESSION THIS FILE EXISTS FOR. Restoring
   * `return DEFAULT_THEME_PREFERENCE` — the coupling ADR-0059 removed — makes
   * every case above resolve to `ACCOUNT_DEFAULT` and turns this red. Without
   * the disagreeing mocks it would stay green, because in production source
   * both constants are `'growth-bright'`.
   */
  it('does not read the account default on any signed-out path', async () => {
    for (const arrange of [
      () => cookieValue.mockReturnValue(undefined),
      () => {
        cookieValue.mockReturnValue('stale');
        validateSession.mockResolvedValue(null);
      },
    ]) {
      vi.clearAllMocks();
      getDependencies.mockReturnValue({ db: {}, sessionConfig: {} });
      arrange();

      await expect(resolveRequestTheme()).resolves.not.toBe(ACCOUNT_DEFAULT);
    }
  });
});

describe('resolveRequestTheme — signed in', () => {
  /**
   * The pin must not leak past the boundary. Pinning an AUTHENTICATED request
   * would silently discard a preference the user explicitly chose and the
   * Appearance page reports as saved.
   */
  it('renders the account preference, not the pinned palette', async () => {
    cookieValue.mockReturnValue('a-valid-token');
    validateSession.mockResolvedValue({ userId: 'user-1' });
    getThemePreference.mockResolvedValue('light');

    await expect(resolveRequestTheme()).resolves.toBe('light');
  });

  it('honours a saved preference that happens to equal neither constant', async () => {
    cookieValue.mockReturnValue('a-valid-token');
    validateSession.mockResolvedValue({ userId: 'user-1' });
    getThemePreference.mockResolvedValue('growth-dark');

    await expect(resolveRequestTheme()).resolves.toBe('growth-dark');
  });
});

describe('resolveRequestTheme — failure', () => {
  /**
   * A colour must never take down the root layout, and an unreachable database
   * must not be guessed past: the preference cannot be known, so the request is
   * treated as signed out rather than painted with a theme the account may not
   * own.
   */
  it('falls back to the pinned palette when the database throws', async () => {
    cookieValue.mockReturnValue('a-valid-token');
    validateSession.mockRejectedValue(new Error('connection refused'));

    await expect(resolveRequestTheme()).resolves.toBe(PINNED);
  });

  it('falls back to the pinned palette when dependencies are unavailable', async () => {
    cookieValue.mockReturnValue('a-valid-token');
    getDependencies.mockImplementation(() => {
      throw new Error('env not configured');
    });

    await expect(resolveRequestTheme()).resolves.toBe(PINNED);
  });

  it('never rejects, whatever the cookie layer does', async () => {
    cookieValue.mockImplementation(() => {
      throw new Error('headers unavailable');
    });

    await expect(resolveRequestTheme()).resolves.toBe(PINNED);
  });
});
