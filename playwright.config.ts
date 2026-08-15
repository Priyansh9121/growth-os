/**
 * Playwright configuration.
 *
 * WHY BROWSER TESTS EXIST NOW
 * Stage 1's flagship login → dashboard transition was verified only by jsdom
 * component tests and by hand. jsdom has no layout, no WebGL and no real
 * navigation, so it cannot tell whether the entrance replays on refresh or
 * whether the canvas is released — the two properties that whole architecture
 * exists to guarantee (ADR-0008). Those need a real browser.
 *
 * The suite runs against a PRODUCTION build, not `next dev`: the development
 * server has different CSP requirements (`unsafe-eval`, unnonced styles), and
 * testing the dev configuration would prove nothing about what ships.
 *
 * @see docs/engineering/testing-strategy.md
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The E2E database. Separate from the development database so a test run
 * cannot destroy work in progress — the suite seeds and truncates freely.
 */
const DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ??
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://growth_os:growth_os@127.0.0.1:5432/growth_os_test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  // Serial by default: the suite shares one seeded database, and parallel
  // workers mutating the same contacts would produce flakes that look like
  // product bugs.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],

  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      /**
       * A second project with reduced motion forced on, so the fallback path
       * is exercised as a first-class experience rather than assumed.
       *
       * Scoped to the auth suite — that is where the 3D scene and the
       * transition live, and they are what reduced motion changes.
       */
      name: 'chromium-reduced-motion',
      use: {
        ...devices['Desktop Chrome'],
        contextOptions: { reducedMotion: 'reduce' },
      },
      testMatch: /auth\.spec\.ts/,
    },
  ],

  webServer: {
    // Build then start: production behaviour, production CSP.
    command: 'npm run build && npm run start',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      // http on loopback is accepted by env validation: browsers treat
      // 127.0.0.1 as a secure context, so `Secure` cookies work and the
      // production configuration is genuinely exercised.
      APP_URL: BASE_URL,
      DATABASE_URL,
      SESSION_SECRET: 'e2e-only-secret-not-used-anywhere-else-32ch',
      SEED_PASSWORD: 'DevOnly!Growth0S',

      /**
       * Raised for the suite, deliberately.
       *
       * The default limit (8 failures per identifier, 24 per IP, per 15
       * minutes) is a PRODUCTION control and it works — the first full run
       * tripped it, because the suite signs in ~30 times from one address in
       * two minutes, which no real user does. That is evidence the limiter
       * functions, not a reason to weaken it.
       *
       * Rate limiting is covered where it can be tested deterministically:
       * `tests/integration/auth-login.test.ts` asserts the limit trips, that a
       * success resets only the identifier counter, and that a limited
       * response is indistinguishable from a wrong password.
       */
      RATE_LIMIT_LOGIN_MAX: '500',
    },
  },
});
