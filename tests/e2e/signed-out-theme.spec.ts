/**
 * The signed-out surface is pinned to `growth-bright` (ADR-0059).
 *
 * WHY THIS NEEDS A REAL BROWSER
 * AGENTS.md §7 is explicit that a green `verify:all` has twice shipped
 * browser-only theme defects, because "the values were right and only the
 * rendered result was wrong". The unit tests here assert which CONSTANT the
 * resolver reads. Only a browser can answer what `<html data-theme>` actually
 * carries on a real response, which is the thing the decision is about.
 *
 * ⚠️ THE BOUNDARY IS THE POINT. A pin that also overrode a signed-in user's
 * saved preference would be a worse bug than the coupling it replaced, so both
 * sides are asserted: the logged-out surface ignores a saved theme, and the
 * logged-in surface still honours it.
 *
 * @see docs/decisions/ADR-0059-signed-out-theme-is-pinned.md
 */

import { expect, test, type Page } from '@playwright/test';

const SEED_PASSWORD = 'DevOnly!Growth0S';
const PINNED = 'growth-bright';

/** The account used for the boundary case. Its preference is moved and restored. */
const USER = 'riley@northbeam.test';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 15_000 });
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /account menu/i }).click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await page.waitForURL('**/login', { timeout: 10_000 });
}

/** What the SERVER painted, read off the root element. */
function renderedTheme(page: Page): Promise<string | null> {
  return page.locator('html').getAttribute('data-theme');
}

/**
 * Choose a theme on the Appearance page and wait for the SAVE, not the click.
 *
 * Same reasoning as `lifecycle.spec.ts`'s `fieldSaved`, and the same flake it
 * was written to close (dev log 0044): `startTransition` resolves when the
 * transition starts, not when the PATCH lands, so signing out immediately
 * afterwards can tear down the request mid-flight and leave the preference
 * unchanged — which would make this test pass for the wrong reason, since the
 * unchanged value IS the pinned one.
 *
 * The promise is created BEFORE the click so a fast response cannot be missed.
 *
 * ⚠️ `.click()`, NEVER `.check()` — AND THAT IS A MEASUREMENT, NOT A STYLE
 * PREFERENCE. `.check()` clicks and then asserts, in the same tick, that the
 * element reports `checked`. `ThemeSetting` cannot satisfy that: the radio is
 * controlled by `checked={theme === option}`, and `setTheme` is raised inside
 * `startTransition`, so it is the LOW-PRIORITY update. The urgent one is
 * `pending`. Probed in a real browser against the production build, the DOM
 * one tick after the click reads:
 *
 *     growth-bright  checked: true   disabled: true      <- unchanged, and frozen
 *     growth-warm    checked: false  disabled: true      <- the one just clicked
 *
 * and only after the PATCH resolves does it become `growth-warm checked: true`.
 * React reverts the radio's native `checked` while it renders the pending UI
 * from the old state, so `.check()`'s post-condition is false at the only
 * instant it ever looks. It failed 100% of the time, not intermittently — the
 * product was correct in every one of those runs and the assertion was not.
 *
 * So the wait is on the observable signal (§6): the response, then a retrying
 * `toBeChecked()`. Never a fixed sleep.
 */
async function chooseTheme(page: Page, label: RegExp): Promise<void> {
  await page.goto('/system/appearance');

  const radio = page.getByRole('radio', { name: label });
  await expect(radio).toBeVisible();

  // A click on the ALREADY-selected radio fires no `change` event, so `choose`
  // never runs and no PATCH is ever sent — waiting for one would hang for the
  // full timeout. Nothing needs saving in that case; the assertion below still
  // has to hold, so the postcondition is proven either way.
  if (!(await radio.isChecked())) {
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/account/theme' &&
        response.request().method() === 'PATCH',
    );
    await radio.click();
    const response = await saved;

    expect(response.status(), 'the theme PATCH must succeed').toBe(200);
  }

  // Retries, because the component only advances `checked` once the save
  // settles. This is the assertion `.check()` was making too early.
  await expect(radio, 'the chosen theme must end up selected').toBeChecked();
}

test.describe('signed out', () => {
  test('the login page renders the pinned palette', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    expect(await renderedTheme(page)).toBe(PINNED);
  });

  test('every pre-authentication screen renders the pinned palette', async ({ page }) => {
    for (const path of ['/login', '/forgot-password', '/reset-password']) {
      await page.goto(path);
      expect(await renderedTheme(page), `${path} must render ${PINNED}`).toBe(PINNED);
    }
  });

  /**
   * The attribute must be in the markup the server sent, not applied afterwards
   * by script. A client-applied theme would flash the wrong palette first, which
   * is the defect ADR-0056's server-side resolution exists to prevent — and a
   * DOM assertion alone cannot tell the two apart.
   */
  test('the palette is in the served HTML, not applied by script', async ({ request }) => {
    const html = await (await request.get('/login')).text();

    expect(html).toContain(`data-theme="${PINNED}"`);
    expect(html.indexOf('data-theme')).toBeLessThan(1000);
  });
});

test.describe('the boundary — a saved preference vs the signed-out pin', () => {
  test.afterEach(async ({ page }) => {
    // Restore, so a later run or spec does not inherit this one's preference.
    await page.context().clearCookies();
    await signIn(page, USER);
    await chooseTheme(page, /^Growth\b(?! Dark| Warm)/);
    await signOut(page);
  });

  /**
   * ⚠️ THE CASE THIS WHOLE TASK EXISTS TO CLOSE. A user saves `growth-warm`,
   * signs out, and lands on the login page. They must see the pinned palette —
   * their preference belongs to the authenticated product, not to the surface
   * that greets someone with no account.
   *
   * Dev log 0040 reported this as already-correct, but it was only ever true by
   * inheritance: both values were `growth-bright`, so the assertion could not
   * fail. It is now true by decision, and this proves it with the two values
   * genuinely different.
   */
  test('a signed-out user with growth-warm saved still sees the pinned palette', async ({
    page,
  }) => {
    await signIn(page, USER);
    await chooseTheme(page, /^Growth Warm/);

    // The preference really is stored and really does paint the app.
    await page.goto('/dashboard');
    expect(await renderedTheme(page)).toBe('growth-warm');

    await signOut(page);

    // ...and does not follow them out of the product.
    expect(await renderedTheme(page)).toBe(PINNED);
    await page.goto('/login');
    expect(await renderedTheme(page)).toBe(PINNED);
  });

  /**
   * The other side of the same boundary. A pin that leaked into authenticated
   * requests would silently discard a choice the Appearance page reports as
   * saved — a worse defect than the coupling being removed.
   */
  test('the pin does not override the preference inside the product', async ({ page }) => {
    await signIn(page, USER);
    await chooseTheme(page, /^Growth Warm/);

    for (const path of ['/dashboard', '/system/appearance', '/customers/contacts']) {
      await page.goto(path);
      expect(await renderedTheme(page), `${path} must honour the saved theme`).toBe('growth-warm');
    }
  });

  /**
   * ⚠️ A RECORDED EDGE, NOT AN ASPIRATION. ADR-0059 pins on the SESSION because
   * a Next.js layout cannot read the pathname — the framework's own docs for
   * 16.3.1 say layouts "do not re-render on navigation, so they do not access
   * pathname which would otherwise become stale". `/login` redirects an
   * authenticated visitor, so it is always genuinely signed out; the two
   * password screens do not, so a signed-in visitor keeps their own theme there.
   *
   * This asserts what was MEASURED rather than what would be tidy, so that a
   * future session choosing to close this edge has to change a test that states
   * the old behaviour outright — instead of discovering it in a browser.
   */
  test('the password screens keep a signed-in visitor’s theme — the stated edge', async ({
    page,
  }) => {
    await signIn(page, USER);
    await chooseTheme(page, /^Growth Warm/);

    // Still authenticated: these routes do not redirect the way /login does.
    await page.goto('/forgot-password');
    await expect(page).toHaveURL(/\/forgot-password/);
    expect(await renderedTheme(page)).toBe('growth-warm');

    await page.goto('/reset-password');
    await expect(page).toHaveURL(/\/reset-password/);
    expect(await renderedTheme(page)).toBe('growth-warm');

    // And /login is the one that does redirect, which is why it is never
    // affected — the pin is not what protects it.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
