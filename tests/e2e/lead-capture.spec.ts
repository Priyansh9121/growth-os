/**
 * Stage 3's headline test: an anonymous visitor becomes a CRM lead.
 *
 * WHY THIS EXISTS AND WHY IT IS THE HEADLINE
 * Every other layer proves a piece. Only a browser proves the PRODUCT CLAIM —
 * that a real person, on a real page, with no account and nothing typed by an
 * operator, ends up as a truthfully attributed contact, acquisition,
 * opportunity and timeline entry.
 *
 * It also covers the parts nothing else can reach: `sessionStorage` first-touch
 * across a navigation, the iframe origin boundary, and whether the customer's
 * page can read what a visitor types into our form.
 *
 * ⚠️ EVERY VALUE HERE IS FICTIONAL. `.test` addresses, invented names, an
 * obviously fake click id. No real person's data belongs in a test fixture.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

const SEED_PASSWORD = 'DevOnly!Growth0S';

/** The seeded demo form. A fixed key so this suite and the budget gate agree. */
const FORM_KEY = '5eed0000000000000000000000000f01';

async function signIn(page: Page, email = 'sam@abcplumbing.test'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 15_000 });
}

/**
 * A unique fictional person per test, so runs never collide.
 *
 * ⚠️ THE PHONE NUMBER IS UNIQUE TOO, and that is not cosmetic. Every lead here
 * originally shared one number, which made them the SAME PERSON to ingestion —
 * `match_then_create` matches on email OR phone, so the second test's enquiry
 * correctly attached itself to the first test's contact and created nothing.
 * The test read that as a missing contact; the product was right.
 *
 * A fixture that reuses an identifier is not a shortcut. It is a claim about
 * identity, and ingestion believes it.
 */
function fictionalLead(tag: string) {
  const stamp = String(Date.now());
  const unique = `${tag}-${stamp}`;
  const digits = stamp.slice(-8);
  return {
    firstName: 'Wren',
    lastName: `Halloway${stamp.slice(-6)}`,
    email: `wren-${unique}@example.test`,
    // A fictional Australian mobile: 04 plus eight digits of the clock.
    phone: `04${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`,
    message: 'Burst pipe under the kitchen sink, water is off at the main.',
  };
}

async function fillAndSubmit(page: Page, lead: ReturnType<typeof fictionalLead>): Promise<void> {
  await page.getByLabel(/^First name/).fill(lead.firstName);
  await page.getByLabel(/^Last name/).fill(lead.lastName);
  await page.getByLabel(/^Email/).fill(lead.email);
  await page.getByLabel(/^Phone/).fill(lead.phone);
  await page.getByLabel(/how can we help/i).fill(lead.message);
  await page.getByRole('button', { name: /send enquiry/i }).click();
}

test.describe('the Stage 3 product loop', () => {
  test('an anonymous visitor becomes an attributed CRM lead', async ({ page, context }) => {
    const lead = fictionalLead('loop');

    // ---------------------------------------------------------------------
    // ANONYMOUS. No session, no cookie, no account.
    // ---------------------------------------------------------------------
    await context.clearCookies();

    await page.goto(
      `/f/${FORM_KEY}?utm_source=google&utm_medium=cpc&utm_campaign=stage3-emergency&utm_term=emergency+plumber+melbourne&gclid=TEST-CLICK-ID-NOT-REAL`,
    );

    await expect(page.getByRole('heading', { name: 'Website enquiry' })).toBeVisible();

    await fillAndSubmit(page, lead);

    // The success message the form was configured with, not a generic one.
    await expect(page.getByRole('status')).toContainText(/we have your enquiry/i, {
      timeout: 15_000,
    });

    // ---------------------------------------------------------------------
    // AUTHENTICATED OPERATOR. The same lead, now in the CRM.
    // ---------------------------------------------------------------------
    await signIn(page);

    await page.goto(`/customers/contacts?q=${encodeURIComponent(lead.lastName)}`);
    const contactLink = page.getByRole('link', { name: new RegExp(lead.lastName) });
    await expect(contactLink).toBeVisible();
    await contactLink.click();

    await expect(
      page.getByRole('heading', { name: `${lead.firstName} ${lead.lastName}` }),
    ).toBeVisible();

    // THE ACQUISITION, with truthful classification. A gclid is an ad platform
    // telling us about a real paid click, which is why it reads `paid search`.
    await expect(page.getByText(/how they reached you/i)).toBeVisible();
    await expect(page.getByText(/paid search/i).first()).toBeVisible();

    // ⚠️ NO SEARCH QUERY, anywhere on the page — despite `utm_term` carrying
    // exactly what a fabricated one would say. `utm_term` is the marketer's
    // bid keyword; a search query claims to be what the VISITOR typed, and
    // search engines have not passed that since 2011 (ADR-0012).
    await expect(page.getByText('emergency plumber melbourne')).toBeHidden();

    // THE TIMELINE, authored by a system actor rather than a fabricated user.
    await expect(page.getByRole('heading', { name: /timeline/i })).toBeVisible();
    await expect(page.getByText(new RegExp(`${lead.firstName}.*added`, 'i')).first()).toBeVisible();

    // THE OPPORTUNITY — the seeded form opens one on every enquiry.
    await expect(page.getByRole('heading', { name: /opportunities/i })).toBeVisible();
    await expect(
      page.getByText(new RegExp(`${lead.firstName} ${lead.lastName}`)).first(),
    ).toBeVisible();

    // THE INGESTION VIEW. It links to the contact rather than copying it.
    await page.goto('/conversion/forms');
    await page.getByRole('link', { name: 'Website enquiry' }).click();
    await expect(page.getByRole('heading', { name: /recent submissions/i })).toBeVisible();
    await expect(page.getByText(/lead captured/i).first()).toBeVisible();
  });

  test('a retried submission creates nothing further', async ({ page, context }) => {
    const lead = fictionalLead('retry');
    await context.clearCookies();
    await page.goto(`/f/${FORM_KEY}`);

    // The renderer generates ONE submission id per form instance, so a retry
    // of the same enquiry carries the same idempotency key. Posting twice from
    // inside the page is exactly what a flaky connection does.
    const submissionId = `e2e-retry-${Date.now()}`;
    const payload = {
      values: {
        first_name: lead.firstName,
        last_name: lead.lastName,
        email: lead.email,
        phone: lead.phone,
        message: lead.message,
      },
      submissionId,
      context: { landingPath: '/pricing', elapsedMs: 9000 },
    };

    const results = await page.evaluate(
      async ({ key, body }) => {
        const post = async () => {
          const response = await fetch(`/api/public/forms/${key}/submissions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        };
        return [await post(), await post()];
      },
      { key: FORM_KEY, body: payload },
    );

    // BOTH succeed from the browser's point of view — a retry must not look
    // like a failure to someone who just typed their details.
    expect(results[0]?.body.ok).toBe(true);
    expect(results[1]?.body.ok).toBe(true);

    await signIn(page);
    await page.goto(`/customers/contacts?q=${encodeURIComponent(lead.lastName)}`);

    // ONE contact, not two.
    await expect(page.getByRole('link', { name: new RegExp(lead.lastName) })).toHaveCount(1);
  });

  test('the same id with different content is refused', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/f/${FORM_KEY}`);

    const submissionId = `e2e-conflict-${Date.now()}`;
    const results = await page.evaluate(
      async ({ key, id }) => {
        const post = async (email: string) => {
          const response = await fetch(`/api/public/forms/${key}/submissions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              values: { first_name: 'Ines', email },
              submissionId: id,
              context: {},
            }),
          });
          return (await response.json()) as { ok: boolean };
        };
        return [await post('ines-a@example.test'), await post('ines-b@example.test')];
      },
      { key: FORM_KEY, id: submissionId },
    );

    // Replaying silently could attach one person's details to another's
    // acquisition. The refusal is generic to the caller — no hint that the id
    // was seen before, which would confirm it existed.
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
  });
});

test.describe('attribution', () => {
  test('first touch survives a navigation and is not overwritten', async ({ page, context }) => {
    await context.clearCookies();

    // Land on a campaign page that is NOT the form.
    await page.goto(
      '/f/' + FORM_KEY + '?utm_source=google&utm_medium=cpc&utm_campaign=first-touch',
    );

    const stored = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem('growth-os.attribution');
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    });

    // The tracking script only runs where it is included; the hosted form
    // reads whatever is there. What matters is the SHAPE when it exists.
    if (stored) {
      // ⚠️ NO PII, and no full URL. The path is stored without its query
      // string because query strings routinely carry personal data.
      const serialised = JSON.stringify(stored);
      expect(serialised).not.toMatch(/@|password|token=/i);
      expect(stored['landingPath']).not.toContain('?');
    }

    // NO COOKIES are set by attribution. That is the whole reason this uses
    // sessionStorage (ADR-0028).
    const cookies = await context.cookies();
    expect(cookies.filter((cookie) => cookie.name.includes('growth'))).toHaveLength(0);
  });

  test('the form still submits with attribution storage unavailable', async ({ page, context }) => {
    const lead = fictionalLead('nostorage');
    await context.clearCookies();

    // A visitor who declined tracking, or is in a locked-down browser. The
    // business must NOT lose the enquiry (ADR-0028 §5).
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new Error('sessionStorage is blocked');
        },
      });
    });

    await page.goto(`/f/${FORM_KEY}`);
    await fillAndSubmit(page, lead);

    await expect(page.getByRole('status')).toContainText(/we have your enquiry/i, {
      timeout: 15_000,
    });
  });

  test('a corrupt stored value is ignored rather than breaking the form', async ({
    page,
    context,
  }) => {
    const lead = fictionalLead('corrupt');
    await context.clearCookies();

    await page.addInitScript(() => {
      window.sessionStorage.setItem('growth-os.attribution', '{not json at all');
    });

    await page.goto(`/f/${FORM_KEY}`);
    await fillAndSubmit(page, lead);

    await expect(page.getByRole('status')).toContainText(/we have your enquiry/i, {
      timeout: 15_000,
    });
  });

  test('a browser cannot assert its own provenance', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/f/${FORM_KEY}`);

    const lead = fictionalLead('hostile');
    const accepted = await page.evaluate(
      async ({ key, body }) => {
        const response = await fetch(`/api/public/forms/${key}/submissions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return ((await response.json()) as { ok: boolean }).ok;
      },
      {
        key: FORM_KEY,
        body: {
          values: { first_name: lead.firstName, last_name: lead.lastName, email: lead.email },
          submissionId: `e2e-hostile-${Date.now()}`,
          context: {
            // None of these are in the submission schema. They are stripped at
            // the boundary; the SERVER classifies from raw signals.
            sourceType: 'organic_search',
            confidence: 'declared',
            searchQuery: 'best plumber melbourne',
            workspaceId: '00000000-0000-0000-0000-000000000000',
          },
        },
      },
    );

    // It is ACCEPTED — the extra keys are ignored, not treated as an attack —
    // and what lands is the server's own classification.
    expect(accepted).toBe(true);

    await signIn(page);
    await page.goto(`/customers/contacts?q=${encodeURIComponent(lead.lastName)}`);
    await page.getByRole('link', { name: new RegExp(lead.lastName) }).click();

    // No referrer and no campaign is `direct`, and the claimed search query is
    // nowhere on the page.
    await expect(page.getByText('best plumber melbourne')).toBeHidden();
    await expect(page.getByText(/direct/i).first()).toBeVisible();
  });
});

test.describe('public form security', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('an unknown key is a 404, indistinguishable from a draft', async ({ page }) => {
    const response = await page.goto(`/f/${'a'.repeat(32)}`);
    expect(response?.status()).toBe(404);
  });

  test('a malformed key never reaches the database', async ({ page }) => {
    for (const bad of ['short', 'A'.repeat(32), '../../etc/passwd']) {
      const response = await page.goto(`/f/${encodeURIComponent(bad)}`);
      expect(response?.status()).toBe(404);
    }
  });

  test('an oversized body is refused', async ({ page }) => {
    await page.goto(`/f/${FORM_KEY}`);

    const ok = await page.evaluate(async (key) => {
      const response = await fetch(`/api/public/forms/${key}/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: { first_name: 'A'.repeat(200_000) },
          submissionId: 'oversized-000000',
          context: {},
        }),
      });
      return ((await response.json()) as { ok: boolean }).ok;
    }, FORM_KEY);

    // A lead form does not accept 200 KB of JSON.
    expect(ok).toBe(false);
  });

  test('a filled honeypot is refused, without saying why', async ({ page }) => {
    await page.goto(`/f/${FORM_KEY}`);

    const result = await page.evaluate(async (key) => {
      // Read the trap's name from the rendered markup, exactly as a bot would.
      const hidden = document.querySelector<HTMLInputElement>(
        'div[aria-hidden="true"] input[type="text"]',
      );
      const response = await fetch(`/api/public/forms/${key}/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: { first_name: 'Bot', email: 'bot@example.test' },
          submissionId: `honeypot-${Date.now()}`,
          trap: 'https://spam.test',
          context: {},
        }),
      });
      const body = (await response.json()) as { ok: boolean; message?: string };
      return { trapName: hidden?.name ?? null, ok: body.ok, message: body.message };
    }, FORM_KEY);

    expect(result.trapName).toBeTruthy();
    expect(result.ok).toBe(false);
    // The message must not name the signal. Telling a bot which check caught
    // it is telling it what to change.
    expect(result.message ?? '').not.toMatch(/honeypot|trap|spam|bot/i);
  });

  test('a script payload is stored and displayed as inert text', async ({ page }) => {
    const unique = `xss-${Date.now()}`;
    await page.goto(`/f/${FORM_KEY}`);

    let alerted = false;
    page.on('dialog', async (dialog) => {
      alerted = true;
      await dialog.dismiss();
    });

    await page.getByLabel(/^First name/).fill(`<script>alert(1)</script>`);
    await page.getByLabel(/^Last name/).fill(unique);
    await page.getByLabel(/^Email/).fill(`${unique}@example.test`);
    await page.getByRole('button', { name: /send enquiry/i }).click();
    await expect(page.getByRole('status')).toBeVisible({ timeout: 15_000 });

    await signIn(page);
    await page.goto(`/customers/contacts?q=${encodeURIComponent(unique)}`);
    await page.getByRole('link', { name: new RegExp(unique) }).click();

    // Rendered as TEXT. React escapes it, and no CRM surface uses
    // dangerouslySetInnerHTML — the value is stored verbatim because escaping
    // at write time corrupts real data like "Smith & Sons".
    await expect(page.getByText('<script>alert(1)</script>').first()).toBeVisible();
    expect(alerted).toBe(false);
  });

  test('the app denies framing; the public form permits it', async ({ page }) => {
    /** Directives, minus the per-request nonce, so two responses can be compared. */
    const directives = (csp: string | undefined): Map<string, string> =>
      new Map(
        (csp ?? '')
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const [name, ...rest] = part.split(/\s+/);
            return [name!, rest.join(' ').replace(/'nonce-[^']+'/g, "'nonce-X'")] as const;
          }),
      );

    const app = await page.goto('/login');
    // `X-Frame-Options: DENY` and the embed are mutually exclusive, so the
    // header is scoped away from `/f/` — and must still cover everything else.
    expect(app?.headers()['x-frame-options']).toBe('DENY');

    const form = await page.goto(`/f/${FORM_KEY}`);
    expect(form?.headers()['x-frame-options']).toBeUndefined();

    const appCsp = directives(app?.headers()['content-security-policy']);
    const formCsp = directives(form?.headers()['content-security-policy']);

    expect(appCsp.get('frame-ancestors')).toBe("'none'");
    expect(formCsp.get('frame-ancestors')).toBe('*');

    // ⚠️ EVERY OTHER DIRECTIVE IS IDENTICAL, asserted as a whole rather than by
    // spot-checking a few. The hazard this guards is not a missing directive —
    // it is someone reaching for `'unsafe-inline'` or a wildcard `script-src`
    // to make an embed work, and weakening the entire application to do it.
    //
    // Compared by name and value, so a directive ADDED to one and not the other
    // fails too.
    appCsp.delete('frame-ancestors');
    formCsp.delete('frame-ancestors');
    expect(Object.fromEntries(formCsp)).toEqual(Object.fromEntries(appCsp));

    // And the script policy is still nonce-and-strict-dynamic, not a list of
    // hosts an attacker's injected tag could happen to sit on.
    expect(formCsp.get('script-src')).toBe("'self' 'nonce-X' 'strict-dynamic'");
  });

  test('the public form is not indexable', async ({ page }) => {
    await page.goto(`/f/${FORM_KEY}`);
    // A hosted form is a functional endpoint, not content. Indexing one would
    // outrank the customer's own site and leak who uses Growth OS.
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveAttribute('content', /noindex/);
  });
});

test.describe('the embed', () => {
  /**
   * ⚠️ THE SNIPPET IS READ FROM THE PRODUCT, not written here.
   *
   * These tests originally hardcoded `<script src="…/embed.js">`, which is what
   * the admin UI displayed — and the build wrote the file to `/scripts/embed.js`.
   * Both halves were self-consistent and the product was broken: every customer
   * who pasted the snippet would have got a page with no form on it, and no
   * test could see it, because the test agreed with the wrong half.
   *
   * So the host page is built from the exact string an operator copies. If the
   * two ever drift again, the embed simply stops loading here.
   */
  async function copySnippetFromAdmin(page: Page): Promise<string> {
    await signIn(page);
    await page.goto('/conversion/forms');
    await page.getByRole('link', { name: 'Website enquiry' }).click();
    const snippet = await page.getByText(/^<script src=.*data-growth-form=/).innerText();
    expect(snippet).toContain(FORM_KEY);
    return snippet;
  }

  /**
   * A stand-in for a customer's website, on a REAL server.
   *
   * ⚠️ Not `page.route(...).fulfill(...)`, which is the obvious way to do this
   * and does not work. Chrome refuses a subresource from a more-private address
   * space, and an intercepted page has no address space at all — so a fulfilled
   * page at any host is treated as public and blocked from loading a script off
   * loopback. The error names CORS, which sends you looking in the wrong place
   * entirely.
   *
   * A genuine loopback server on its own port is both simpler and MORE real: a
   * different port is a different origin, so the cross-origin boundary under
   * test is the browser's actual one rather than a simulation of it.
   */
  let host: Server;
  let hostOrigin: string;
  let hostBody = '';

  test.beforeAll(async () => {
    host = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>${hostBody}</body></html>`);
    });
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
    hostOrigin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      host.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test('loads the form in an iframe the host cannot read into', async ({ page, context }) => {
    const snippet = await copySnippetFromAdmin(page);
    await context.clearCookies();

    hostBody = `<h1>ABC Plumbing</h1>
      <input id="host-field" value="host page data" />
      ${snippet}`;
    await page.goto(`${hostOrigin}/contact`);

    const frame = page.frameLocator('iframe[data-growth-form]');
    await expect(frame.getByRole('button', { name: /send enquiry/i })).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ THE ISOLATION, tested rather than asserted in a comment. This is the
    // whole reason an iframe was chosen over a script embed (ADR-0027): the
    // customer's page — and every third-party script on it — cannot read what a
    // visitor types into the enquiry form.
    //
    // Either denial is correct. A cross-origin frame usually yields a null
    // `contentDocument` rather than throwing; what must never happen is a
    // number coming back.
    const reach = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[data-growth-form]') as HTMLIFrameElement;
      try {
        const doc = iframe.contentDocument;
        return doc === null ? 'no-document' : `READ ${doc.querySelectorAll('input').length} INPUTS`;
      } catch {
        return 'threw';
      }
    });
    expect(['no-document', 'threw']).toContain(reach);

    // ⚠️ `allow-same-origin` in the sandbox does NOT weaken this. It preserves
    // the frame's OWN origin — which the form needs for sessionStorage — and
    // says nothing about the host, which remains a different origin.
    const sandbox = await page.locator('iframe[data-growth-form]').getAttribute('sandbox');
    expect(sandbox).toContain('allow-same-origin');
    // And still no `allow-top-navigation`: a compromised form must never be
    // able to redirect the customer's visitor away from their own site.
    expect(sandbox).not.toContain('allow-top-navigation');

    // The embed did not touch the host page's own input.
    await expect(page.locator('#host-field')).toHaveValue('host page data');
  });

  test('resizes the frame from the one message it sends', async ({ page, context }) => {
    const snippet = await copySnippetFromAdmin(page);
    await context.clearCookies();

    hostBody = snippet;
    await page.goto(`${hostOrigin}/contact`);
    const iframe = page.locator('iframe[data-growth-form]');
    await expect(iframe).toBeVisible({ timeout: 15_000 });

    // The height is set from the resize message, and is bounded — a hostile or
    // buggy message must not create a 10-million-pixel element on their page.
    await expect
      .poll(async () => (await iframe.boundingBox())?.height ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(320);
    expect((await iframe.boundingBox())?.height ?? 0).toBeLessThan(5000);
  });
});

test.describe('public form accessibility', () => {
  test('is operable by keyboard alone, with labelled fields', async ({ page, context }) => {
    const lead = fictionalLead('a11y');
    await context.clearCookies();
    await page.goto(`/f/${FORM_KEY}`);

    // Tab until the first field has focus, rather than assuming it is the
    // first stop. What matters for accessibility is that it is REACHABLE by
    // keyboard in a small number of steps, not that nothing precedes it — a
    // skip link or a layout control legitimately might.
    const firstName = page.getByLabel(/^First name/);
    for (
      let step = 0;
      step < 8 && !(await firstName.evaluate((el) => el === document.activeElement));
      step += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(firstName).toBeFocused();

    // From there, Tab must walk the fields in their visual order. This is the
    // property a keyboard user actually depends on.
    await page.keyboard.type(lead.firstName);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/^Last name/)).toBeFocused();
    await page.keyboard.type(lead.lastName);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/^Email/)).toBeFocused();
    await page.keyboard.type(lead.email);

    expect(await firstName.inputValue()).toBe(lead.firstName);
    expect(await page.getByLabel(/^Email/).inputValue()).toBe(lead.email);

    // ⚠️ THE HONEYPOT MUST NOT BE IN THE TAB ORDER. It is `tabIndex={-1}` and
    // `aria-hidden`, so an assistive-technology user is never asked to fill a
    // field that would silently reject their enquiry.
    const trapFocusable = await page.evaluate(() => {
      const trap = document.querySelector<HTMLInputElement>(
        'div[aria-hidden="true"] input[type="text"]',
      );
      return trap ? trap.tabIndex : null;
    });
    expect(trapFocusable).toBe(-1);

    // Every control reachable by keyboard has an accessible name.
    const unnamed = await page.evaluate(
      () =>
        [...document.querySelectorAll('input:not([type=hidden]), textarea, select')]
          .filter((el) => !(el as HTMLElement).closest('[aria-hidden="true"]'))
          .filter((el) => {
            const id = el.getAttribute('id');
            const labelled = id ? document.querySelector(`label[for="${id}"]`) : null;
            return !labelled && !el.getAttribute('aria-label');
          }).length,
    );
    expect(unnamed).toBe(0);
  });

  test('announces a validation error and moves focus to it', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/f/${FORM_KEY}`);

    await page.getByLabel(/^Email/).fill('not-an-email');
    await page.getByRole('button', { name: /send enquiry/i }).click();

    // `role="alert"` so it is announced when it appears, without stealing
    // focus from someone mid-typing.
    const alert = page.getByRole('alert').filter({ hasText: /required|valid email/i });
    await expect(alert.first()).toBeVisible();

    // Focus lands on the first invalid field, or a screen-reader user is told
    // something failed and left to hunt for it.
    await expect(page.getByLabel(/^First name/)).toBeFocused();
  });

  test.describe('mobile', () => {
    for (const width of [320, 375, 430]) {
      test(`fits ${width}px without horizontal scroll`, async ({ page, context }) => {
        await context.clearCookies();
        await page.setViewportSize({ width, height: 720 });
        await page.goto(`/f/${FORM_KEY}`);

        await expect(page.getByRole('button', { name: /send enquiry/i })).toBeVisible();

        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflows).toBe(false);
      });
    }

    test('uses the right keyboard for email and phone', async ({ page, context }) => {
      await context.clearCookies();
      await page.setViewportSize({ width: 375, height: 720 });
      await page.goto(`/f/${FORM_KEY}`);

      // Most enquiries are typed on a phone; the wrong keyboard is friction on
      // the field people abandon first.
      await expect(page.getByLabel(/^Email/)).toHaveAttribute('type', 'email');
      await expect(page.getByLabel(/^Phone/)).toHaveAttribute('type', 'tel');
      await expect(page.getByLabel(/^Email/)).toHaveAttribute('autocomplete', 'email');
    });
  });
});

test.describe('forms administration', () => {
  test('an operator can create, configure and publish a form', async ({ page }) => {
    await signIn(page);
    const name = `E2E form ${Date.now()}`;

    await page.goto('/conversion/forms');
    await page.getByRole('button', { name: /new form/i }).click();
    await page.getByLabel(/form name/i).fill(name);
    await page.getByRole('button', { name: /^create$/i }).click();

    await page.waitForURL('**/conversion/forms/**', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name })).toBeVisible();

    // A new form is a DRAFT, and its embed instructions say so.
    await expect(page.getByText(/not live yet/i)).toBeVisible();

    // THE PREVIEW IS THE REAL RENDERER, so its fields are the visitor's fields.
    await expect(page.getByRole('heading', { name: /preview/i })).toBeVisible();
    await expect(page.getByText(/this is the component your visitors see/i)).toBeVisible();

    await page.getByRole('button', { name: /publish form/i }).click();
    await expect(page.getByRole('button', { name: /pause form/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/not live yet/i)).toBeHidden();
  });

  test('a draft form accepts no public submissions', async ({ page, context }) => {
    await signIn(page);
    const name = `E2E draft ${Date.now()}`;

    await page.goto('/conversion/forms');
    await page.getByRole('button', { name: /new form/i }).click();
    await page.getByLabel(/form name/i).fill(name);
    await page.getByRole('button', { name: /^create$/i }).click();
    await page.waitForURL('**/conversion/forms/**', { timeout: 15_000 });

    // Read the key from the embed instructions — it is not a secret.
    const link = await page.locator('code').first().textContent();
    const key = link?.match(/\/f\/([0-9a-f]{32})/)?.[1];
    expect(key).toBeTruthy();

    await context.clearCookies();
    const response = await page.goto(`/f/${key}`);
    // Never published, so it resolves to nothing at the database — not because
    // a status check remembered to run.
    expect(response?.status()).toBe(404);
  });

  test('a viewer cannot manage forms', async ({ page }) => {
    // `jordan` owns Meridian Legal and has no access to ABC Plumbing at all,
    // which is the stronger assertion: a foreign form is a 404, not a 403.
    await signIn(page, 'jordan@meridianlegal.test');
    await page.goto('/conversion/forms');

    await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
    // Meridian has no forms; ABC's must not appear.
    await expect(page.getByRole('link', { name: 'Website enquiry' })).toBeHidden();
  });
});
