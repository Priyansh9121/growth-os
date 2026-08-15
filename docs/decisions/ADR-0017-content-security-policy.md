# ADR-0017 — Nonce-based Content Security Policy

**Status:** Accepted
**Date:** 2026-08-15
**Supersedes the Stage 1 gap:** "no CSP" was recorded as known debt in
[security/threat-model.md](../security/threat-model.md) T8.

## Context

Stage 1 deliberately shipped without a CSP, on the reasoning that a policy full
of `'unsafe-inline'` looks like protection while providing almost none. Stage 2
introduces the first real customer PII, so the debt is now due.

Next.js injects inline bootstrap scripts, so a strict policy requires
per-request nonces. Implementation follows the official Next.js 16 guidance
(docs verified against version 16.3.1, last updated 2026-03-20).

## Decision

Nonce-based CSP generated in `apps/web/src/proxy.ts`.

### Production policy

```
default-src 'self';
script-src 'self' 'nonce-{n}' 'strict-dynamic';
style-src 'self' 'nonce-{n}';
style-src-attr 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
```

Development additionally allows `'unsafe-eval'` in `script-src` (React uses
`eval` to reconstruct server error stacks) and `'unsafe-inline'` in `style-src`
(the dev server injects unnonced style tags). **Neither is present in
production**, and a test asserts that.

### The mechanism

Per the Next.js contract: the proxy generates a nonce, sets it on the
**request** headers as both `x-nonce` and `Content-Security-Policy`, and on the
**response** header. Next.js parses the request CSP header, extracts the nonce,
and applies it automatically to framework scripts, page bundles and its own
inline tags.

### `style-src-attr 'unsafe-inline'` — the one deliberate relaxation

Growth OS sets CSS custom properties via inline `style` attributes: the
dashboard entrance choreography (`--gos-enter-delay`) and React Three Fiber's
canvas sizing. CSP governs inline style _attributes_ under `style-src` unless
`style-src-attr` is specified separately.

The options were:

1. `style-src 'unsafe-inline'` — would also permit inline `<style>` **elements**.
2. `style-src-attr 'unsafe-inline'` — permits only attributes. **Chosen.**
3. Remove all inline styles — would require a stylesheet class per delay value
   and give up R3F's canvas sizing.

Option 2 is a genuine, bounded relaxation: an inline style attribute cannot
execute JavaScript in any current browser (IE's `expression()` is long dead).
Its residual risk is CSS-based data exfiltration via attribute selectors, which
requires an existing injection point that `script-src` already blocks.

Recorded here rather than buried, because **the failure mode we were avoiding
was silently weakening `script-src` to make things work.** `script-src` is not
weakened.

### Dynamic rendering

Nonces require dynamic rendering — Next.js cannot inject a nonce into a page
generated at build time. All application routes are already `force-dynamic`
(they depend on the session cookie). `/_not-found` was statically generated and
is now explicitly dynamic, because under `'strict-dynamic'` a static page's
unnonced scripts would be blocked.

The cost is stated plainly: **static optimisation and PPR are unavailable
while nonce CSP is in force.** For an application that is entirely behind
authentication and already fully dynamic, that costs nothing today. If a public
marketing surface is ever added to this app, it should be a separate deployment
rather than a reason to weaken the policy.

### Proxy matcher

Broadened from Stage 1's app-route list to all page requests, excluding `api`,
`_next/static`, `_next/image`, `favicon.ico` and `next/link` prefetches. The
authentication redirect logic is now explicitly scoped to application paths
inside the function, so widening the matcher did not widen the redirect.

## Alternatives considered

### A — Hash-based CSP with experimental SRI

_Attractive:_ keeps static generation and CDN caching.

**Rejected:** `experimental.sri` is explicitly experimental in Next.js, and the
authentication-gated application is dynamic regardless — so the benefit
(static caching) does not apply. Revisit if a public surface appears.

### B — `script-src 'self' 'unsafe-inline'` without nonces

**Rejected.** This is precisely the "looks like protection" outcome Stage 1
declined to ship. `'unsafe-inline'` in `script-src` defeats the primary purpose
of CSP.

### C — Report-only first

_Attractive:_ zero risk of breaking the app.

**Rejected as the end state**, but a good operational practice: `Report-Only`
is supported via `CSP_REPORT_ONLY=true` for a staging soak. The default is
enforcing, because a report-only policy left on indefinitely is the most common
way CSP projects quietly fail.

## Consequences

### Positive

- Genuine XSS mitigation: an injected script has no valid nonce.
- `frame-ancestors 'none'` supersedes `X-Frame-Options` in modern browsers.
- `form-action 'self'` blocks credential exfiltration to an external endpoint.
- `base-uri 'self'` blocks `<base>` tag hijacking of relative script URLs.

### Negative

- No static optimisation or PPR while nonces are in force.
- Every page render generates a nonce (negligible: one `randomUUID`).
- Third-party scripts (analytics, chat widgets) will each need an explicit
  allowance and a review — deliberate friction.
- `style-src-attr 'unsafe-inline'`, as analysed above.

### Risks and mitigations

| Risk                                                | Mitigation                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A future integration prompts weakening `script-src` | This ADR is the record that it must not be; add the specific origin instead                  |
| Policy breaks a page silently in production         | Tests assert the header and its critical directives; `CSP_REPORT_ONLY` allows a staging soak |
| `frame-ancestors` blocks a future white-label embed | Stage 19 needs a per-tenant policy; noted in `security-architecture.md`                      |

## Revisit when

- White-label embedding (Stage 19) → per-tenant `frame-ancestors`.
- A third-party script is required → add its origin, never `'unsafe-inline'`.
- A public marketing surface is added → separate deployment, or SRI.

## Related

- [security/threat-model.md](../security/threat-model.md) T8
- [architecture/security-architecture.md](../architecture/security-architecture.md)
