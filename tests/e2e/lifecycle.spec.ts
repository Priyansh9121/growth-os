/**
 * Data lifecycle browser coverage: merge, erasure, tags, custom fields, import.
 *
 * WHY THESE NEED A REAL BROWSER
 * The other layers prove the rules hold. These prove an operator can actually
 * reach them: that the merge preview loads before the button is offered, that
 * the erasure panel shows what survives, that a merged contact's URL redirects
 * rather than 404s, and that a member is not shown controls they cannot use.
 *
 * jsdom cannot demonstrate any of those — no navigation, no layout, no real
 * fetch against a real route handler holding a real tenant transaction.
 *
 * ⚠️ These tests MUTATE customer data irreversibly by design. They run against
 * the E2E database, which the suite seeds and truncates freely, and they create
 * their own fixtures rather than erasing seeded records other specs depend on.
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

/**
 * Create a contact through the API and return its id.
 *
 * Through the API rather than the UI: these specs are about the LIFECYCLE
 * screens, and driving the create dialog first would make a failure there look
 * like a failure here.
 *
 * Issued with `page.evaluate` rather than `page.request`, because every
 * state-changing route validates `Origin` and fails closed when it is absent
 * (ADR-0004). Playwright's request context sends no Origin, so `page.request`
 * is correctly rejected — running the fetch INSIDE the page means the browser
 * sets the header itself, which is also the path a real client takes.
 */
async function createContact(
  page: Page,
  contact: { firstName: string; lastName?: string; email?: string; phone?: string },
): Promise<string> {
  const result = await page.evaluate(async (payload) => {
    const response = await fetch('/api/crm/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, body: await response.text() };
  }, contact);

  expect(result.ok, result.body).toBe(true);
  return (JSON.parse(result.body) as { contact: { id: string } }).contact.id;
}

/**
 * The page's own alerts, excluding Next.js's route announcer.
 *
 * Next renders a permanent `role="alert"` live region for route changes, and a
 * bare `getByRole('alert')` resolves to it first — so an assertion about an
 * error message silently waits on an empty div instead. Same trap Stage 2 hit.
 */
function alerts(page: Page) {
  return page.getByRole('alert').filter({ hasNotText: '' }).and(page.locator(':not([id])'));
}

/**
 * Wait for a custom-field save to be CONFIRMED by the server.
 *
 * ⚠️ THE SAVE IS FIRE-AND-FORGET, WHICH IS WHY THIS EXISTS.
 * `ContactCustomFields` commits on blur through `onCommit={() => void save(...)}`
 * — deliberately not awaited, so the field stays responsive while a spinner and
 * a `role="status"` "Saving …" message report progress. Nothing in the DOM
 * settles synchronously, so `blur()` returning tells you the request was
 * STARTED, not that it finished.
 *
 * `page.reload()` immediately afterwards therefore raced the PUT and could tear
 * it down mid-flight, leaving the field empty on the reloaded page. That is the
 * intermittent failure dev log 0043 recorded and 0044 left open. Proven under a
 * controlled 800 ms delay on the route: the old sequence fails every time, and
 * this one passes (dev log 0044).
 *
 * ⚠️ IT WAITS ON THE RESPONSE, NOT ON THE SPINNER. The "Saving …" indicator is
 * the obvious candidate and is the wrong one: a fast save can come and go before
 * a poll observes it, so "wait until it is absent" is trivially true before the
 * request has even begun. The promise below is created BEFORE the action that
 * triggers it, so it cannot miss the response however fast the server answers.
 * Never a fixed sleep — that narrows the window without closing it (§6).
 */
function fieldSaved(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      /\/api\/crm\/contacts\/[^/]+\/fields$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'PUT',
  );
}

test.describe('contact merge', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
  });

  test('previews the blast radius, merges, and redirects the old id', async ({ page }) => {
    const shared = `merge-${Date.now()}@example.test`;
    const survivor = await createContact(page, {
      firstName: 'Robin',
      lastName: 'Ashford',
      email: shared,
    });
    const duplicate = await createContact(page, {
      firstName: 'Robin',
      email: shared,
      phone: '0412 111 222',
    });

    await page.goto(`/customers/contacts/${survivor}/merge`);

    await expect(page.getByRole('heading', { name: /merge into robin ashford/i })).toBeVisible();

    // The preview must arrive before the operator is offered the button.
    await expect(page.getByRole('heading', { name: /what moves/i })).toBeVisible();

    // The duplicate holds a phone the survivor lacks: a free gain needing no
    // decision, so it appears under gains and not under conflicts.
    await expect(page.getByRole('heading', { name: /fill a gap/i })).toBeVisible();
    await expect(page.getByText('0412 111 222')).toBeVisible();

    // The warning is not buried.
    await expect(page.getByText(/this cannot be undone/i)).toBeVisible();

    await page.getByRole('button', { name: /^merge into robin ashford$/i }).click();
    await page.waitForURL(`**/customers/contacts/${survivor}`, { timeout: 15_000 });

    // The gap was filled from the duplicate.
    await expect(page.getByText('0412 111 222')).toBeVisible();

    // THE REDIRECT. The merged id was valid and the record still exists, so it
    // resolves to the survivor rather than 404ing a bookmarked link.
    await page.goto(`/customers/contacts/${duplicate}`);
    await page.waitForURL(`**/customers/contacts/${survivor}`, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Robin Ashford' })).toBeVisible();
  });

  test('a conflicting field must be chosen, and is never combined', async ({ page }) => {
    const shared = `conflict-${Date.now()}@example.test`;
    const survivor = await createContact(page, {
      firstName: 'Kit',
      lastName: 'Marlowe',
      email: shared,
    });
    await createContact(page, { firstName: 'Kit', lastName: 'Marlow', email: shared });

    await page.goto(`/customers/contacts/${survivor}/merge`);

    await expect(page.getByRole('heading', { name: /disagree/i })).toBeVisible();
    await expect(page.getByText(/values are never combined/i)).toBeVisible();

    // Take the duplicate's spelling.
    await page.getByRole('radio', { name: /replace with.*Marlow$/i }).check();
    await page.getByRole('button', { name: /^merge into kit marlowe$/i }).click();
    await page.waitForURL(`**/customers/contacts/${survivor}`, { timeout: 15_000 });

    // "Marlowe Marlow" would be the failure. One surname, chosen explicitly.
    await expect(page.getByRole('heading', { name: 'Kit Marlow' })).toBeVisible();
  });
});

test.describe('contact erasure', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
  });

  test('shows what survives, requires the phrase, and leaves no trace', async ({ page }) => {
    const id = await createContact(page, {
      firstName: 'Delphine',
      lastName: 'Okonjo',
      email: `erase-${Date.now()}@example.test`,
    });

    await page.goto(`/customers/contacts/${id}`);
    await page.getByRole('button', { name: /erase personal details/i }).click();

    // Both halves of the story, side by side. Someone who believes erasure
    // deletes the sale will avoid using a feature they are obliged to use.
    await expect(page.getByRole('heading', { name: /^removed$/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^kept$/i })).toBeVisible();
    await expect(page.getByText(/deal values, stages/i)).toBeVisible();

    // The button stays disabled until the phrase is typed exactly.
    const confirm = page.getByRole('button', { name: /erase permanently/i });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/type erase to confirm/i).fill('erase');
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/type erase to confirm/i).fill('ERASE');
    await expect(confirm).toBeEnabled();

    await confirm.click();

    await expect(page.getByRole('heading', { name: 'Erased contact' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Delphine')).toBeHidden();

    // The record is gone from search by the name it used to carry.
    await page.goto('/customers/contacts?q=Okonjo');
    await expect(page.getByRole('link', { name: /Okonjo/ })).toBeHidden();
  });
});

test.describe('tags and custom fields', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
  });

  test('defines a tag and a custom field, then applies both', async ({ page }) => {
    const suffix = Date.now();
    const tagName = `Priority ${suffix}`;
    const fieldLabel = `Property type ${suffix}`;

    await page.goto('/system/crm-fields');

    await page.getByLabel(/^Tag name$/).fill(tagName);
    await page.getByRole('button', { name: /^add tag$/i }).click();
    await expect(page.getByText(tagName)).toBeVisible();

    await page.getByLabel(/^Field name$/).fill(fieldLabel);
    await page.getByRole('button', { name: /^add field$/i }).click();
    await expect(page.getByText(fieldLabel)).toBeVisible();

    const id = await createContact(page, {
      firstName: 'Imogen',
      email: `tagged-${suffix}@example.test`,
    });
    await page.goto(`/customers/contacts/${id}`);

    // The tag does not appear until the server confirms it — tags drive
    // segmentation, and a chip that looks applied but is not would send the
    // wrong list of people the wrong campaign.
    await page.getByLabel(/add a tag/i).selectOption({ label: tagName });
    await page.getByRole('button', { name: /^add$/i }).click();

    // `exact` matters: the name legitimately appears three times once applied —
    // in the chip, in the polite live region that announces the change, and in
    // the remove button's accessible name. All three are correct; only the chip
    // is what this assertion is about.
    await expect(page.getByText(tagName, { exact: true })).toBeVisible();

    // The remove control exists and is reachable by its accessible name.
    await expect(page.getByRole('button', { name: `Remove tag ${tagName}` })).toBeVisible();

    // The custom field form is rendered FROM the definition, not hard-coded.
    const field = page.getByLabel(fieldLabel);
    await expect(field).toBeVisible();
    // Created BEFORE the blur that triggers the save, so the response cannot
    // be missed. See `fieldSaved`.
    const saved = fieldSaved(page);
    await field.fill('Terrace');
    await field.blur();
    await saved;

    await page.reload();
    await expect(page.getByLabel(fieldLabel)).toHaveValue('Terrace');
  });

  test('rejects a value that does not fit its type', async ({ page }) => {
    const suffix = Date.now();
    const fieldLabel = `Bedrooms ${suffix}`;

    await page.goto('/system/crm-fields');
    await page.getByLabel(/^Field name$/).fill(fieldLabel);
    await page.getByLabel(/^Type$/).selectOption({ label: 'Number' });
    await page.getByRole('button', { name: /^add field$/i }).click();
    await expect(page.getByText(fieldLabel)).toBeVisible();

    const id = await createContact(page, {
      firstName: 'Rafiq',
      email: `typed-${suffix}@example.test`,
    });
    await page.goto(`/customers/contacts/${id}`);

    // A `number` input will not accept letters, so the check is that the
    // server's rule is what governs — the field commits empty rather than
    // storing something it cannot compare.
    const field = page.getByLabel(fieldLabel);
    const saved = fieldSaved(page);
    await field.fill('12');
    await field.blur();
    await saved;
    await page.reload();
    await expect(page.getByLabel(fieldLabel)).toHaveValue('12');
  });
});

test.describe('CSV import', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'sam@abcplumbing.test');
  });

  test('validates before writing, then imports and reports honestly', async ({ page }) => {
    const suffix = Date.now();
    // ⚠️ The SURNAME is unique, not only the email.
    //
    // This searched for `/Halloway/` and asserted one match, which held until
    // the Stage 3 lead-capture suite started creating its own Halloways in the
    // same database — six of them, and a strict-mode violation. A test that
    // asserts on a name another suite can also produce is asserting on shared
    // mutable state.
    const surname = `Halloway${suffix}`;
    const csv = [
      'First name,Last name,Email,Source',
      `Wren,${surname},wren-${suffix}@example.test,Google`,
      `Ines,Barros${suffix},ines-${suffix}@example.test,Word of mouth`,
      // No first name and no identity: reported, never imported.
      ',,,',
    ].join('\n');

    await page.goto('/customers/import');

    await page.getByLabel(/csv file/i).setInputFiles({
      name: 'contacts.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    });

    // Step two: the mapping is PROPOSED and shown, never applied silently.
    await expect(page.getByRole('heading', { name: /match your columns/i })).toBeVisible();
    await expect(page.getByLabel(/import Email as/i)).toHaveValue('email');
    // A "Source" column maps to a note, never to measured attribution.
    await expect(page.getByLabel(/import Source as/i)).toHaveValue('sourceDetail');

    await page.getByRole('button', { name: /check the rows/i }).click();

    // Step three: counts before anything is written.
    await expect(page.getByRole('heading', { name: /review before importing/i })).toBeVisible();
    await expect(page.getByText(/1 row needs attention/i)).toBeVisible();

    await page.getByRole('button', { name: /^import 2 rows$/i }).click();

    await expect(page.getByRole('heading', { name: /import completed/i })).toBeVisible({
      timeout: 20_000,
    });

    await page.goto(`/customers/contacts?q=${surname}`);
    await expect(page.getByRole('link', { name: new RegExp(surname) })).toBeVisible();
  });

  test('refuses a file it cannot read, without importing anything', async ({ page }) => {
    await page.goto('/customers/import');

    await page.getByLabel(/csv file/i).setInputFiles({
      name: 'broken.csv',
      mimeType: 'text/csv',
      // Two columns with the same heading: rows are keyed by header, so one
      // would silently win.
      buffer: Buffer.from('Email,Email\na,b\n', 'utf8'),
    });

    await expect(alerts(page)).toContainText(/both called/i);
    await expect(page.getByRole('heading', { name: /match your columns/i })).toBeHidden();
  });
});

test.describe('authorization is visible in the interface', () => {
  test('a member is not shown the destructive controls', async ({ page }) => {
    // `riley` reaches ABC Plumbing transitively as an agency admin, so this
    // asserts the agency path grants what it should — and the tenant-denial
    // spec covers what it should not.
    await signIn(page, 'sam@abcplumbing.test');

    const id = await createContact(page, {
      firstName: 'Cass',
      email: `perm-${Date.now()}@example.test`,
    });

    await page.goto(`/customers/contacts/${id}`);

    // An owner sees both.
    await expect(page.getByRole('link', { name: /merge a duplicate/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /erase personal details/i })).toBeVisible();
  });
});
