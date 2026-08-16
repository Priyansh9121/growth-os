# 0015 — Forms administration, and what a browser found

**Date:** 2026-08-16 · **Stage:** 3

## Objective

Give an operator the interface to create, configure, publish and monitor a form,
and then prove the whole Stage 3 claim in a real browser.

## Initial state

A working public path with no way to configure it. The demo form existed only
because the seed script inserted it.

## Decisions

### Publishing is a separate act from editing

A form is a draft until it is published, and publishing creates an immutable
version. The status the public endpoint reads is the **published** version, so
editing a live form cannot silently change what an in-flight visitor is filling
in.

### The public key is displayed in full

It is not a secret. It appears in the customer's page source and in a URL, and
every security property holds with it fully public
([ADR-0026](../decisions/ADR-0026-public-form-resolution.md) §1). Masking it, or
warning about it, would teach the operator something false about how their own
system works.

What is not shown: the workspace id, the form id, or anything else internal.

### The submissions list shows rejections, with reasons

The public response is identical for every refusal; the operator's list is not.
"47 rejected: honeypot" is the only place that distinction is useful, and a bot
cannot read it.

### The submissions list links to the contact rather than copying it

A submission is a receipt. The lead is the contact, the acquisition and the
opportunity — and those are what erasure governs. A list that showed the
submitted values would be a second copy of every enquiry, outside erasure's
reach.

## Failures encountered

Six, and the interesting ones are all cases where **the product was wrong and
consistent with itself**, which is precisely what a browser test is for.

### 1. The embed snippet pointed at a URL nothing served

The admin UI told operators to paste:

```html
<script src="https://app.example/embed.js" data-growth-form="…"></script>
```

The build wrote the file to `public/scripts/embed.js`, served at
`/scripts/embed.js`.

Both halves were internally consistent, both had been read several times, and
**every customer who pasted that snippet would have got a page with no form on
it**. The E2E test did not catch it either at first — it hardcoded the same
wrong URL, because it was written from the same assumption.

Two fixes, and the second is the one that matters:

1. The paths are now constants in `@growth-os/contracts`
   (`EMBED_SCRIPT_PATH`, `TRACKING_SCRIPT_PATH`), because an embed URL is closer
   to a database column than to an internal path — changing it breaks pages that
   already exist.
2. **The test now reads the snippet out of the admin UI and pastes it into the
   stand-in customer page.** It no longer has an opinion about the URL. If the
   two drift again, the embed simply stops loading.

### 2. Attribution was lost on the hosted form itself

The headline test asserted a `gclid` visit is classified `paid search`. It was
classified `direct`.

The tracking script writes attribution on a customer's site. The **hosted** form
at `/f/<key>` is often the landing page itself — an email campaign, a QR code, a
social bio link — and it was reading storage that nothing had written.

Everything downstream had behaved perfectly on data that never arrived, and the
result was that every one of those visits was recorded as `direct` and the
campaign that paid for it was invisible.

`readUrlAttribution()` is the fix: the hosted form reads its own URL when
storage is empty, applying the same privacy rules — path only, origin only, a
referrer from our own origin discarded. **First touch still wins**; the URL is a
fallback, not an override.

### 3. Every fictional lead was the same person

Ten tests created contacts from a fixture with one shared phone number.
Ingestion matches on email **or** phone, so the second test's enquiry correctly
attached itself to the first test's contact and created nothing. The test read
that as a missing contact and reported a bug in idempotency.

The product was right. A fixture that reuses an identifier is not a shortcut —
it is a claim about identity, and ingestion believes it.

### 4. The suite tripped its own rate limiter

The headline test passed, and then everything after the fifth submission failed
at its success message. Twenty-five browser tests share one loopback address and
one seeded form; the per-IP-per-form limit is five an hour.

That is the limiter working, not a defect. The submission limits became
configuration with production defaults — the same arrangement
`RATE_LIMIT_LOGIN_MAX` has had since Stage 1 — validated as positive integers,
so there is **no value that turns the limiter off**.

### 5. A CSP assertion that would have failed on every page

The framing test asserted the public form's policy did not contain
`'unsafe-inline'`. It does, in `style-src-attr`, deliberately and boundedly, on
every route in the product.

The assertion was measuring the wrong thing. It now parses both policies into
directives and asserts they are **identical except `frame-ancestors`** — which
is the actual property worth defending: nobody weakens the whole application's
script policy to make an embed work.

### 6. Chrome would not load the embed at all, and blamed CORS

The stand-in customer page was served with `page.route(...).fulfill(...)`, and
the browser refused the script:

> Access to script … has been blocked by CORS policy: the request client is not
> a secure context and the resource is in more-private address space `loopback`.

Not CORS. An intercepted response has **no address space**, so a fulfilled page
counts as public and may not load anything from loopback. Changing the host name
did not help; neither did changing the port.

The fix is a genuine `node:http` server on an ephemeral loopback port, which is
both simpler and more real: a different port is a different origin, so the
cross-origin boundary under test is the browser's actual one.

While fixing it, the isolation assertion got stronger. It expected
`contentDocument` to **throw**; a cross-origin frame usually returns `null`
instead. Both are denials, and asserting only one of them meant the test could
have passed for the wrong reason. It now accepts either and fails on any number
coming back — plus asserts the sandbox still grants `allow-same-origin` (the
frame's own origin, which the form needs) and still withholds
`allow-top-navigation`.

### Two smaller ones

A **build artefact was being served publicly**: the origin-substituted source
was staged as `public/scripts/.embed.js.staged.js` and never deleted, so an
unminified copy of both scripts, comments and all, was downloadable. Staging now
happens in a temp directory — nothing that is not deliberately published belongs
in `public/`.

The **keyboard test counted Tab presses** from the top of the document, which
assumed the first field was the first stop. It now tabs until the first field
has focus and asserts the order from there, plus that the honeypot is
`tabIndex === -1` — a trap a keyboard user could reach is a trap for the wrong
person.

## Files created

```
apps/web/src/app/(app)/conversion/forms/{page,[id]/page}.tsx
apps/web/src/components/forms/{form-editor,create-form-button,
                               embed-instructions,submissions-table}.tsx
apps/web/src/app/api/crm/forms/**
tests/e2e/lead-capture.spec.ts
packages/contracts/src/forms/public-scripts.ts
```

Also: the **tracking snippet is now shown to operators**. It was built, served
and documented, and nothing in the product ever told a customer to install it —
so cross-page first-touch attribution was working code nobody could switch on.

## Testing

`tests/e2e/lead-capture.spec.ts` — the headline loop, idempotency under retry,
conflict, attribution (first touch, blocked storage, corrupt storage, hostile
provenance), public-form security (unknown key, malformed key, oversized body,
honeypot, script payload, framing headers, `noindex`), the embed (cross-origin
isolation, sandbox, resize), accessibility (keyboard order, error announcement,
320/375/430 px, input types), and forms administration.

The headline test is the one that matters. It signs in as nobody, submits an
enquiry with a `gclid` and a `utm_term`, then signs in as an operator and finds
the contact, the acquisition classified `paid search`, the opportunity, the
timeline entry authored by a system actor — and asserts the `utm_term` text
appears **nowhere on the page**, because a bid keyword is not a search query.

## Result

Stage 3's claim is demonstrated end to end in a real browser rather than
asserted. Six defects found, all of them invisible to the layers below.

## Remaining work

- No sites administration UI. The model exists and origins are configurable per
  form; a workspace-level site list waits for Stage 4's crawler, which needs it
  for a different reason.
- No challenge provider.
- Burst rate limiting is still per-instance ([ADR-0009](../decisions/ADR-0009-rate-limiting.md)).
