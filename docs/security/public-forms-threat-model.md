# Public Forms — Threat Model

**Status:** Implemented (Stage 3)
**Last verified:** 2026-08-16

`POST /api/public/forms/:publicKey/submissions` is the first Growth OS endpoint
reachable by **anyone on the internet**, with no account and no session. This
document is what protects it, and what does not.

---

## 1. What an attacker gets for free

Stated first, because a threat model that starts from what we protect tends to
assume things that are not true.

- **The public key.** It is in the customer's page source and in a URL. Every
  property below must hold with it fully public.
- **The endpoint's shape.** The form renders its own field list.
- **Unlimited attempts from many addresses.** Nothing here assumes one attacker,
  one IP, or a browser.
- **Complete control of the `Origin` header** from anything that is not a
  browser.

## 2. Threats and controls

| #   | Threat                                       | Control                                                                                                                | Strength                             |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | **Cross-tenant lead injection**              | The key resolves to exactly one workspace through `resolve_public_form`. `workspaceId` is not in the submission schema | **Strong.** Structural               |
| 2   | **Key enumeration**                          | 128 bits of entropy, database CHECK enforcing the shape, malformed keys rejected before a query                        | **Strong**                           |
| 3   | **Probing which keys exist**                 | Unknown, draft, inactive and archived all answer identically                                                           | **Strong**                           |
| 4   | **Fabricated provenance**                    | `sourceType`, `confidence`, `searchQuery` are not in the schema. The server classifies deterministically               | **Strong.** Structural               |
| 5   | **Duplicate leads from retries**             | Idempotency receipt keyed `(workspace, source_system, external_key)`                                                   | **Strong**                           |
| 6   | **One id reused for different content**      | `ConflictError`, never a silent replay                                                                                 | **Strong**                           |
| 7   | **Payload flooding**                         | 32 KB body cap checked at `Content-Length` and again after read                                                        | **Strong**                           |
| 8   | **Field flooding**                           | Per-field `maxLength` from the published version; values truncated                                                     | **Strong**                           |
| 9   | **Volume / cost amplification**              | Two-tier rate limiting — see §3                                                                                        | **Moderate.** See the honest limits  |
| 10  | **Naive spam bots**                          | Honeypot with a per-version field name                                                                                 | **Weak, and treated as weak**        |
| 11  | **Scripted instant submits**                 | Minimum time-to-submit, default 2s                                                                                     | **Weak**                             |
| 12  | **Determined spam**                          | Challenge provider seam, no provider configured                                                                        | **Absent today.** Named, not implied |
| 13  | **Stored XSS in the CRM**                    | React escaping; no `dangerouslySetInnerHTML` anywhere; asserted in a browser                                           | **Strong**                           |
| 14  | **Open redirect**                            | Success URL validated as `https:` by a URL parse at config time AND before navigation                                  | **Strong**                           |
| 15  | **Embedding on a hostile page**              | Optional allowed origins                                                                                               | **Weak by nature.** See §4           |
| 16  | **Host page reading form input**             | Cross-origin iframe                                                                                                    | **Strong.** Structural               |
| 17  | **Our script reading the host page**         | The loader touches nothing but its own attributes                                                                      | **Strong.** Structural               |
| 18  | **Frame-jacking the app**                    | `X-Frame-Options: DENY` everywhere except `/f/`; `frame-ancestors` per route                                           | **Strong**                           |
| 19  | **PII in logs / events**                     | Receipts hold no values; events hold identifiers; the rate limiter hashes the IP                                       | **Strong**                           |
| 20  | **Privilege escalation via the public path** | System grant of exactly one capability                                                                                 | **Strong.** Asserted by test         |

## 3. Rate limiting — what is actually true

Two tiers ([ADR-0030](../decisions/ADR-0030-worker-and-queue.md) §3):

| Tier      | Where      | Default limit                                  | Scope                        |
| --------- | ---------- | ---------------------------------------------- | ---------------------------- |
| Burst     | In-process | 5 / 10s per IP+form                            | **Per application instance** |
| Sustained | PostgreSQL | 5/h per IP+form · 20/h per IP · 200/h per form | **Shared and durable**       |

The burst tier runs first and costs no I/O, so a flood is refused before it can
amplify into database writes.

Those are **defaults**, supplied by the composition root from
`PUBLIC_SUBMISSION_MAX_*` — the same arrangement `RATE_LIMIT_LOGIN_MAX` has had
since Stage 1. Nothing inside `@growth-os/forms` reads the environment; the
numbers arrive as an argument, and the package's own default is the production
one.

They are validated as **positive integers**, so they can be raised for a
high-traffic campaign or lowered for a form under attack, and there is no value
that disables the limiter. That is the property that makes this configuration
rather than a switch.

The E2E suite raises them, and the reason is worth recording: the first full
lead-capture run passed its headline test and then failed everything after the
fifth submission, because 25 browser tests share one loopback address and one
seeded form. The limiter working on a test suite is evidence, not a defect.

### ⚠️ The honest limitation

**With one application instance — which is what Growth OS runs today — the
burst tier is genuinely effective. With several it becomes per-instance**, and
the durable tier carries the whole guarantee.

That is not a claim of distributed protection, and it should not be read as
one. It is the same release gate [ADR-0009](../decisions/ADR-0009-rate-limiting.md)
recorded in Stage 1, still open, and now with a durable second tier behind it
so the failure mode is degraded rather than absent.

Redis is deliberately **not** the answer yet: consulting it on every submission
would put a new hard dependency in the lead path, where failing closed stops a
customer's form accepting enquiries and failing open silently disables the
limiter.

## 4. Allowed origins — what they are and are not

A form may list origins permitted to embed it.

**`Origin` is a browser-supplied header.** A browser sets it honestly; `curl`,
a script, or anything else sets it to whatever it likes. So this raises the cost
of embedding someone else's form on a hostile page, and **it is not a tenancy
control.**

Tenancy comes from the key resolving to exactly one workspace. Matching is exact
after normalisation — no subdomain wildcards, because on a platform with user
content (`*.wordpress.com`) a wildcard would permit every other tenant of that
platform. An empty list means any origin, which is the correct default for a
form whose purpose is to be embedded on sites we do not know about yet.

The application's own origin is always permitted, or configuring a list would
silently break the hosted form and the admin preview.

## 5. CORS, and why `*` is correct here

The endpoint answers `Access-Control-Allow-Origin: *`.

It is designed to be called from arbitrary customer websites; it carries no
cookies (`Allow-Credentials` is absent, so a browser will not attach them); and
it returns no internal identifiers. There is nothing an attacker's page learns
by calling it that it could not learn from a server.

Restricting CORS to a form's allowed origins would break the moment a customer
added a staging domain, and would buy nothing.

## 6. Why there is no CSRF token

Public submissions are **intentionally cross-site** — that is what an embed is.
Copying `rejectUntrustedOrigin` from the authenticated API would refuse every
real customer embed.

Tenant safety here comes from the key, the schema, the abuse controls, the
idempotency receipt and a capability-limited system actor. None of it depends on
the request originating from our own origin.

## 7. The privileged read

`resolve_public_form` is the one `SECURITY DEFINER` function in this path.

One text input · a fixed narrow output · pinned `search_path` · no dynamic SQL ·
reads `forms` and `form_versions` only. It cannot reach a contact, a submission,
or another workspace's anything. RLS is **disabled nowhere**.

The worst it can leak is the public configuration of one form whose key the
caller already holds — which that form renders to the open internet anyway.

## 8. What a rejection tells the attacker

**Nothing.** Spam, rate limits, a paused form, an unknown key, a failed
validation and a missing identity all return the same message with the same
status. Telling a bot which signal caught it is telling it what to change.

The operator sees the real reason in the submissions list, which is where it is
useful.

## 9. Verification

```bash
npm run test:integration    # packages/forms — 33 cases, restricted DB role
npm run e2e                 # tests/e2e/lead-capture.spec.ts
```

Negatives covered: unknown key · malformed key · draft form · paused form ·
cross-workspace resolution · browser-supplied workspace ignored · origin outside
the list · hosted origin always allowed · oversized body · honeypot · flood ·
reused id with different content · fabricated `sourceType` / `confidence` /
`searchQuery` · script payload rendered inert · receipt free of values · event
free of PII · rate-limit rows free of IPs · system grant refusing erase, merge
and export · a member unable to manage forms.

## 10. Known gaps

| Gap                              | Status                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| No CAPTCHA / Turnstile provider  | Seam exists (`SubmissionChallengeVerifier`); the default **accepts everything and says so in its name** |
| Burst limiting is per-instance   | Release gate, ADR-0009. Durable tier mitigates                                                          |
| No reputation or IP intelligence | Not built. Not implied anywhere in the UI                                                               |
| Allowed origins are forgeable    | Documented wherever they are configured                                                                 |

## Related

- [ADR-0025](../decisions/ADR-0025-system-actors.md) · [ADR-0026](../decisions/ADR-0026-public-form-resolution.md) · [ADR-0027](../decisions/ADR-0027-embed-mechanism.md)
- [architecture/lead-capture-architecture.md](../architecture/lead-capture-architecture.md)
- [threat-model.md](threat-model.md) — the product-wide model
