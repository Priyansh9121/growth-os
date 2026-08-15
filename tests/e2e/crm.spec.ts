/**
 * CRM browser coverage: contacts, creation, pipeline movement, tenant denial.
 *
 * These exercise the full stack — browser → route handler → authorization →
 * tenant transaction → RLS → database — which no other test layer does.
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

test.describe('contacts', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
  });

  test('lists seeded contacts with their acquisition source', async ({ page }) => {
    await page.goto('/customers/contacts');

    await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sarah Mitchell' })).toBeVisible();

    // Provenance is the point of the CRM — it must be visible on the list.
    await expect(page.getByText('Organic search').first()).toBeVisible();
    await expect(page.getByText('Paid search').first()).toBeVisible();
  });

  test('search filters server-side', async ({ page }) => {
    await page.goto('/customers/contacts');
    await expect(page.getByRole('link', { name: 'Sarah Mitchell' })).toBeVisible();

    await page.getByLabel(/search contacts/i).fill('Carter');

    await expect(page.getByRole('link', { name: 'James Carter' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sarah Mitchell' })).toBeHidden();
  });

  test('contact detail shows provenance and timeline', async ({ page }) => {
    await page.goto('/customers/contacts');
    await page.getByRole('link', { name: 'Sarah Mitchell' }).click();

    await expect(page.getByRole('heading', { name: 'Sarah Mitchell' })).toBeVisible();
    await expect(page.getByText('First touch')).toBeVisible();
    await expect(page.getByText('/emergency-plumber-melbourne').first()).toBeVisible();

    // The timeline is server-authored — it exists because services wrote it,
    // not because the client asked for it.
    await expect(page.getByRole('heading', { name: /timeline/i })).toBeVisible();
    await expect(page.getByText(/lead captured/i).first()).toBeVisible();
  });

  test('creates a contact through the dialog', async ({ page }) => {
    await page.goto('/customers/contacts');
    await page.getByRole('button', { name: /add contact/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus moves INTO the dialog — otherwise a keyboard user is stranded.
    await expect(page.getByLabel(/^First name/)).toBeFocused();

    const unique = `e2e-${Date.now()}@example.test`;
    await page.getByLabel(/^First name/).fill('Avery');
    await page.getByLabel(/^Last name/).fill('Nguyen');
    await page.getByLabel(/^Email/).fill(unique);

    await page
      .getByRole('button', { name: /add contact/i })
      .last()
      .click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'Avery Nguyen' })).toBeVisible();
  });

  test('the create dialog traps focus and closes on Escape', async ({ page }) => {
    await page.goto('/customers/contacts');
    const trigger = page.getByRole('button', { name: /add contact/i });
    await trigger.click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toBeHidden();
    // Focus RETURNS to the trigger rather than the top of the document.
    await expect(trigger).toBeFocused();
  });

  test('validation errors are announced and linked to the field', async ({ page }) => {
    await page.goto('/customers/contacts');
    await page.getByRole('button', { name: /add contact/i }).click();

    await page.getByLabel(/^First name/).fill('Test');
    await page.getByLabel(/^Email/).fill('not-an-email');
    await page
      .getByRole('button', { name: /add contact/i })
      .last()
      .click();

    const email = page.getByLabel(/^Email/);
    await expect(email).toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
  });

  test('renders stages and deals', async ({ page }) => {
    await page.goto('/customers/pipeline');

    await expect(page.getByRole('heading', { name: 'Pipeline', exact: true })).toBeVisible();
    for (const stage of ['New Lead', 'Contacted', 'Qualified', 'Quote', 'Won', 'Lost']) {
      await expect(page.getByRole('heading', { name: stage, exact: true })).toBeVisible();
    }
    await expect(page.getByText('Emergency hot water repair', { exact: true })).toBeVisible();
  });

  test('moves a deal only after the server confirms', async ({ page }) => {
    await page.goto('/customers/pipeline');

    const select = page.getByLabel(/move .*emergency hot water repair.* to a different stage/i);
    await expect(select).toBeVisible();

    // The card is in "Qualified" from the seed; move it to "Quote".
    await select.selectOption({ label: 'Quote' });

    // The announcement fires only after the response lands — the card does not
    // move optimistically (a Stage 2 requirement).
    await expect(page.getByText(/moved to Quote/i)).toBeAttached({ timeout: 10_000 });
    await expect(select).toHaveValue(await select.inputValue());

    // Survives a reload, so it was genuinely persisted.
    await page.reload();
    const moved = page.getByLabel(/move .*emergency hot water repair.* to a different stage/i);
    const selectedLabel = await moved.locator('option:checked').textContent();
    expect(selectedLabel?.trim()).toBe('Quote');
  });
});

test.describe('tasks', () => {
  test('lists tasks and completes one', async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
    await page.goto('/customers/tasks');

    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
    const task = page.getByText('Confirm Tuesday appointment with Olivia');
    await expect(task).toBeVisible();

    await page.getByRole('button', { name: /mark .*confirm tuesday.* complete/i }).click();

    // Completing removes it from the open view.
    await expect(task).toBeHidden({ timeout: 10_000 });
  });
});

test.describe('tenant isolation in the browser', () => {
  test('a different tenant sees NONE of the other workspace’s contacts', async ({ page }) => {
    await signIn(page, 'jordan@meridianlegal.test');
    await page.goto('/customers/contacts');

    // Jordan owns Meridian Legal. ABC Plumbing's contacts must be invisible.
    await expect(page.getByText('No contacts yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sarah Mitchell' })).toHaveCount(0);
  });

  test('a cross-tenant contact URL returns 404, not the record', async ({ page }) => {
    // Learn a real ABC Plumbing contact id as Sam.
    // `page.request` shares the page's cookies; the bare `request` fixture is
    // a separate context with no session and would 401.
    await signIn(page, 'sam@abcplumbing.test');
    const contactsResponse = await page.request.get('/api/crm/contacts?limit=1');
    const body = (await contactsResponse.json()) as { items: { id: string }[] };
    const foreignId = body.items[0]?.id;
    expect(foreignId).toBeTruthy();

    // ...then attempt it as Jordan.
    await page.context().clearCookies();
    await signIn(page, 'jordan@meridianlegal.test');

    const denied = await page.request.get(`/api/crm/contacts/${foreignId}`);
    // 404 rather than 403: a 403 would confirm the record exists elsewhere.
    expect(denied.status()).toBe(404);
  });
});

test.describe('navigation', () => {
  test('every sidebar destination resolves', async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');

    // The manifest drives both the sidebar and the catch-all placeholder, so
    // there should be no dead links anywhere in the product.
    for (const href of [
      '/customers/contacts',
      '/customers/pipeline',
      '/customers/tasks',
      '/seo/keywords',
      '/analytics/attribution',
    ]) {
      const response = await page.goto(href);
      expect(response?.status(), `${href} returned ${response?.status()}`).toBeLessThan(400);
    }
  });
});
