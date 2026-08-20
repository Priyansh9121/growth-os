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
// Resolved in one place, shared with the global setup and the `verify:e2e`
// preflight — a preflight that checked a different database than the suite
// connects to would be a check that lies. See tests/e2e/database-url.mjs.
import { e2eDatabaseUrl } from './tests/e2e/database-url.mjs';

const PORT = Number(process.env['E2E_PORT'] ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const DATABASE_URL = e2eDatabaseUrl();

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

      /**
       * Raised for the same reason, and discovered the same way.
       *
       * The public submission defaults (5/h per IP+form, 20/h per IP, 5 per 10s
       * burst) are a PRODUCTION control, and the first full lead-capture run
       * proved they work: the headline test passed, then the sixth submission
       * of the suite was refused and every subsequent test failed at its
       * success message. All 25 tests share one loopback address and one seeded
       * form, which is precisely the pattern the per-IP-per-form limit exists
       * to stop.
       *
       * The limits themselves are covered where they can be asserted
       * deterministically — `packages/forms` integration tests drive the
       * counter to its ceiling and check that the refusal is indistinguishable
       * from every other rejection.
       */
      PUBLIC_SUBMISSION_MAX_PER_IP_FORM: '500',
      PUBLIC_SUBMISSION_MAX_PER_IP: '500',
      PUBLIC_SUBMISSION_BURST_MAX: '500',
    },
  },
});
