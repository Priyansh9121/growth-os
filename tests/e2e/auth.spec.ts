/**
 * Authentication and the flagship login → dashboard transition.
 *
 * WHY THESE NEED A REAL BROWSER
 * jsdom has no navigation, no layout and no WebGL. It cannot answer the two
 * questions ADR-0008's whole architecture exists to guarantee:
 *
 *   1. Does the entrance choreography replay on an authenticated refresh?
 *   2. Is the WebGL canvas released once the transition completes?
 *
 * Both were verified by hand in Stage 1. Now they are verified on every run.
 */

import { expect, test, type Page } from '@playwright/test';

const SEED_PASSWORD = 'DevOnly!Growth0S';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 15_000 });
}

test.describe('login', () => {
  test('login page loads and is operable by keyboard alone', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();

    // Email is autofocused, so a keyboard user starts where typing belongs.
    await expect(page.getByLabel(/^Email/)).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/^Password/)).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /show password/i })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeFocused();
  });

  test('rejects a wrong password with an announced, non-enumerating message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/^Email/).fill('sam@abcplumbing.test');
    await page.getByLabel(/^Password/).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /^sign in$/i }).click();

    // Next.js renders its own empty role="alert" route announcer, so scope to
    // the alert that actually carries text.
    const alert = page.getByRole('alert').filter({ hasText: /incorrect/i });
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(/email or password is incorrect/i);

    // Still on /login, and focus returned so the user can retry immediately.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel(/^Email/)).toBeFocused();
  });

  test('an unknown email produces the IDENTICAL message', async ({ page }) => {
    // Account enumeration: the two failures must be indistinguishable.
    await page.goto('/login');
    await page.getByLabel(/^Email/).fill('nobody@nowhere.test');
    await page.getByLabel(/^Password/).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await expect(page.getByRole('alert').filter({ hasText: /incorrect/i })).toHaveText(
      /email or password is incorrect/i,
    );
  });

  test('a valid sign-in reaches the dashboard', async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
    await expect(page.getByRole('heading', { name: /abc plumbing/i })).toBeVisible();
  });

  test('unauthenticated dashboard access redirects to login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test('sign-out returns to login and revokes access', async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');

    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();
    await page.waitForURL('**/login', { timeout: 10_000 });

    // The session is dead server-side, not merely forgotten client-side.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('login → dashboard transition (ADR-0008)', () => {
  test('the WebGL canvas is released once the transition completes', async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');

    // At `complete` the scene host renders null, freeing the WebGL context.
    // A leaked context surfaces much later as a blank canvas on an unrelated
    // page, which is extremely hard to diagnose — so it is asserted here.
    await expect(page.locator('canvas')).toHaveCount(0, { timeout: 10_000 });
  });

  test('refreshing the dashboard does NOT replay the entrance', async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
    await expect(page.locator('canvas')).toHaveCount(0, { timeout: 10_000 });

    await page.reload();

    // The machine initialises to `complete` when the app boots on an app
    // route, so no canvas is ever created and no choreography runs.
    await expect(page.getByRole('heading', { name: /abc plumbing/i })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.locator('.gos-enter')).toHaveCount(0);
  });

  test('a direct authenticated visit never creates a canvas', async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
    await page.goto('/customers/contacts');
    await page.goto('/dashboard');

    await expect(page.locator('canvas')).toHaveCount(0);
  });
});

test.describe('reduced motion', () => {
  test('the 3D scene is NOT mounted, and sign-in still works', async ({ page }) => {
    // Under `prefers-reduced-motion: reduce` the lattice is not slowed — it is
    // never created. The static composition renders instead, and the machine
    // skips the convergence phases entirely (ADR-0008, 3d-system.md §2).
    //
    // In the default project this assertion would be vacuous after the
    // transition completes, so it only means something in the reduced-motion
    // project — where the canvas must be absent from the very first paint.
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);

    await page.getByLabel(/^Email/).fill('sam@abcplumbing.test');
    await page.getByLabel(/^Password/).fill(SEED_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();

    // The user arrives at the same place, having waited less.
    await page.waitForURL('**/dashboard', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /abc plumbing/i })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  });
});

test.describe('content security policy (ADR-0017)', () => {
  test('serves a nonce-based policy with no unsafe-inline scripts', async ({ page }) => {
    const response = await page.goto('/login');
    const csp = response?.headers()['content-security-policy'];

    expect(csp, 'CSP header must be present').toBeTruthy();
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");

    // The rule this whole ADR exists to protect: script-src must never be
    // weakened to make something work.
    const scriptSrc = csp?.split(';').find((part) => part.trim().startsWith('script-src'));
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test('the nonce differs on every request', async ({ page }) => {
    const first = (await page.goto('/login'))?.headers()['content-security-policy'];
    const second = (await page.goto('/login'))?.headers()['content-security-policy'];

    const nonceOf = (csp?: string) => csp?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  test('the page runs without CSP violations', async ({ page }) => {
    // A policy that blocks the app's own scripts is worse than no policy.
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) violations.push(message.text());
    });

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await page.waitForTimeout(1500);

    expect(violations, `CSP violations: ${violations.join(' | ')}`).toHaveLength(0);
  });
});
