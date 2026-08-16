# 0013 — The public path: endpoint, hosted form, embed and tracker

**Date:** 2026-08-16 · **Stage:** 3

## Objective

Make the design in [0012](0012-stage-3-reorder-and-lead-capture-design.md)
reachable from a browser that has never authenticated.

## Initial state

A package, a migration and a classifier, with no caller outside tests.

## Decisions

### The endpoint differs from every other route, deliberately

`POST /api/public/forms/:publicKey/submissions` breaks four conventions the
authenticated API holds, and each break is written down at the top of the file
rather than discovered later:

| Convention                  | Broken because                                                                  |
| --------------------------- | ------------------------------------------------------------------------------- |
| CSRF origin check           | A public submission is **intentionally cross-site** — that is what an embed is  |
| Session-derived actor       | There is no session. The key resolves the tenant, a grant limits the capability |
| Structured error responses  | One identical refusal for every cause                                           |
| Body parsed, then validated | Size is checked at `Content-Length` **and** after read, before `JSON.parse`     |

### One refusal, status 200

Spam, rate limits, a paused form, an unknown key, a failed validation and a
missing identity all return the same message with the same status.

Status 200 rather than 4xx for the same reason as the message: a bot that can
distinguish rejections by status code learns exactly what it would learn from a
worded error. The operator sees the real reason in their submissions list, which
is where it is useful and where a bot cannot read it.

### CORS `*`, which is correct and looks wrong

The endpoint is designed to be called from arbitrary customer websites, carries
no cookies (`Allow-Credentials` is absent, so a browser will not attach them),
and returns no internal identifiers — not a contact id, not an acquisition id,
not a workspace id, only the caller's own submission id echoed back.

Restricting CORS to a form's allowed origins would break the moment a customer
added a staging domain and would buy nothing.

### The abuse controls are named as weak

Honeypot, minimum time-to-submit, two-tier rate limiting. Every one is
defeatable and none is described as bot detection.

The threshold logic follows from one asymmetry: **a rejected spam submission
costs nothing; a rejected real enquiry is a customer the business never learns
about.** So the timing check is generous — a keyboard-fluent person using
autofill genuinely does complete a short form in three seconds.

The CAPTCHA seam is an interface whose default implementation is called
`NoChallengeVerifier`. A silently permissive pass-through is how "we have
CAPTCHA" becomes true in conversation and false in production.

### One renderer, three surfaces

The hosted form at `/f/<key>`, the iframe embed and the admin preview are the
same component. Three renderers would drift, and the one that drifts is always
the one a customer sees.

### The tracker sends nothing anywhere

`track.js` makes **no network request at all**. It reads the URL, truncates a
referrer to its origin and a path to its path, and writes one `sessionStorage`
key. Attribution reaches the server only when the visitor chooses to submit a
form — so a page with the tracker on it and no enquiry produces no record of the
visit anywhere.

`window.GrowthOS.disableAttribution()` exists so a customer's own consent banner
can turn it off.

### CSP: scoped, not weakened

`X-Frame-Options: DENY` and an embeddable form are mutually exclusive. The
header is scoped away from `/f/` with a negative lookahead
(`/:path((?!f/).*)`), and `frame-ancestors` is `*` there and `'none'`
everywhere else.

**Every other directive is identical.** The nonce, `strict-dynamic`, the absence
of `unsafe-inline` in `script-src` — none of it changes to make an embed work.
The browser test asserts this by comparing the two policies directive by
directive rather than spot-checking, because the failure mode being guarded is
someone reaching for `'unsafe-inline'` to fix an embed and weakening the whole
application.

## Failures encountered

### A `Date` inside a raw SQL template, for the third time

```ts
sql`… ${publicSubmissionLimits.windowStartedAt} < ${windowStart} …`; // throws
```

postgres.js does not serialise a `Date` bound into a raw template; Drizzle's
typed builders do. Third occurrence in this codebase after `= any(${jsArray})`
twice, and always found at runtime.

The fix is an explicit ISO string with a cast. Recorded again because a class of
bug that has appeared three times is not bad luck, and the type system cannot
see it: a raw template accepts anything.

### The public form is not indexable, and nearly was

A hosted form is a functional endpoint, not content. Indexed, it would compete
with the customer's own site for their own brand terms and publish a list of who
uses Growth OS. `noindex` is on the route, and asserted in the browser.

## Files created

```
apps/web/src/app/api/public/forms/[publicKey]/submissions/route.ts
apps/web/src/app/f/[publicKey]/page.tsx
apps/web/src/components/forms/form-renderer.tsx
apps/web/scripts/embed.src.js          → public/scripts/embed.js
apps/web/scripts/track.src.js          → public/scripts/track.js
scripts/build-public-scripts.mjs
packages/forms/src/public/{resolve,submit,abuse,honeypot}.ts
```

## Measurement

```bash
npm run build:public-scripts
```

| Script     | Raw     | Gzip      | Budget  |
| ---------- | ------- | --------- | ------- |
| `embed.js` | 1,010 B | **632 B** | 2,048 B |
| `track.js` | 1,351 B | **708 B** | 3,072 B |

Their own build with their own hard budget, because these are the only Growth OS
code that runs on someone else's domain. Nobody notices 40 KB in a dashboard;
everybody notices it on a marketing site's Lighthouse score. No React, no shared
imports — a shared import is how a 600-byte loader acquires a dependency tree.

## Security impact

- The first endpoint reachable without an account. Its threat model is
  [public-forms-threat-model.md](../security/public-forms-threat-model.md),
  which states what is **strong**, what is **weak**, and what is **absent**.
- The rate limiter stores `SHA-256(scope:value)`. **The IP address is never
  written**, so an operator with database access cannot read the addresses of a
  customer's website visitors out of it.
- No raw payload is archived anywhere.

## Testing

Integration tests against a real database as a restricted non-owner role, plus
unit tests over the pure decisions. The negatives are the point: unknown key,
malformed key, draft form, paused form, cross-workspace resolution, a
browser-supplied `workspaceId` ignored, origin outside the list, oversized body,
honeypot, flood, a reused id with different content, and fabricated
`sourceType` / `confidence` / `searchQuery`.

## Result

An anonymous browser can create a truthfully attributed CRM lead. Nothing yet
proved it in a real browser — that is [0015](0015-forms-admin-and-the-browser-suite.md).

## Remaining work

- No admin UI for forms yet; the demo form is seeded.
- No job runner, so nothing retains or prunes on a schedule
  ([0014](0014-the-worker-and-a-hang.md)).
