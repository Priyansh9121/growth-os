# 0008 — Stage 2 security, browser testing and verification

**Date:** 2026-08-15 · **Stage:** 2

## Objective

Close the Stage 1 CSP debt, prove tenant isolation on real customer data, add
browser coverage for the flagship transition, and gate bundle growth.

## Initial state

CRM built ([0007](0007-crm-services-and-interface.md)). Five Stage 1
limitations still open: no CSP, no E2E, no bundle gate, per-process rate
limiting, no invitations.

## Investigation

**CSP.** Verified the implementation against the official Next.js 16 guidance
(fetched, version-matched to 16.3.1) and against the copy bundled in
`node_modules/next/dist/docs`. The nonce contract is specific: the proxy sets
the nonce on the **request** headers as both `x-nonce` and
`Content-Security-Policy`, and Next.js parses it out to apply to its own
scripts.

One thing the documentation does not cover, and which would have broken the
product: Growth OS sets CSS custom properties via inline `style`
**attributes** — the dashboard entrance choreography and React Three Fiber's
canvas sizing. `style-src` blocks those unless handled. The tempting fix is
`style-src 'unsafe-inline'`; the correct one is `style-src-attr
'unsafe-inline'`, which permits attributes only, not inline `<style>`
elements. **`script-src` is not weakened** — which was the entire reason
Stage 1 declined to ship a policy at all.

**Rate limiting.** Re-examined and deliberately left per-process. Adding Redis
solely to claim distributed limiting would introduce a required dependency and
a new failure mode in the authentication path before we run a second instance.
The documented release gate stands.

## Decisions

1. **Nonce-based CSP, enforcing by default.** `CSP_REPORT_ONLY=true` exists for
   a staging soak, but the default is enforcing — a report-only policy left on
   indefinitely is how CSP projects quietly fail.
2. **Invitation-only access; no public registration** (ADR-0018). Recorded
   explicitly so "we decided" and "we forgot" stay distinguishable.
3. **E2E runs against a PRODUCTION build.** The dev server needs
   `'unsafe-eval'` and unnonced styles, so testing it would prove nothing about
   what ships.
4. **A loopback carve-out in env validation.** Production requires https —
   except on `localhost`/`127.0.0.1`, which browsers treat as secure contexts.
   Without it, the E2E suite could not exercise the production configuration at
   all, which was the point.

## Failures encountered

**The E2E suite found a real UI bug that nothing else could.** Sign-out timed
out: the account dropdown was being covered by page content. The top bar had
`z-30`, but that ordered it only within its wrapper `<div>` — the wrapper sat
at `z-auto`, and `<main>`, later in the DOM, painted above it. Every unit and
component test passed, because jsdom has no layout. Fixed by moving the
z-index onto the wrapper.

**The first E2E run failed entirely** because a `.refine()` edit to env
validation had not applied — a string-replace that silently matched nothing.
The build was fine; the guard was not. Caught because the server refused to
boot and the error text was the _old_ wording. Now verified both directions:
loopback http accepted, non-loopback http rejected.

**The E2E suite tripped a real production control.** The reduced-motion
project's sign-ins failed with "Too many attempts" — the login rate limiter,
working exactly as designed. The suite authenticates ~30 times from one address
in two minutes, which no real user does.

That is evidence the limiter functions, not a reason to weaken it. The E2E
environment raises the limit explicitly, with a comment recording why; rate
limiting is covered where it can be tested deterministically, in
`tests/integration/auth-login.test.ts`.

**Five test-quality failures**, all locator issues rather than product bugs:
Next.js renders its own empty `role="alert"` route announcer; a landing path
legitimately appears three times on a contact page; a deal title also appears
in an `sr-only` label; and Playwright's bare `request` fixture is a separate
context with no session cookies.

## Files created

`playwright.config.ts` (two projects — default and forced reduced motion) ·
`tests/e2e/{global-setup,auth.spec,crm.spec}.ts` ·
`scripts/check-bundle-budget.mjs` · `packages/auth/src/invitations.ts` ·
`packages/database/src/crm-isolation.integration.test.ts` · unit tests for
normalisation, provenance, capabilities and pagination.

## Files modified

`proxy.ts` (CSP + broadened matcher, with the auth redirect explicitly scoped
so widening the matcher did not widen the redirect) · `env.ts` (loopback) ·
`app-shell.tsx` (stacking fix) · testing harness (CRM truncation).

## Security impact

- **CSP closed** — Stage 1 threat T8's known gap.
- **Invitation privilege escalation closed** — an inviter cannot grant a role
  stronger than their own; covered by a negative test.
- **Isolation proven on customer data** — 17 negative assertions across ten
  tenant tables, connected as a restricted non-owner role, including
  cross-tenant JOINs, `WITH CHECK` on update, append-only enforcement and the
  provenance trigger.

## Testing

Full suite green. Counts in the final report.

## Result

Two of the thirteen Stage 1 limitations are closed (CSP, E2E), one more is
partially closed (bundle gate now exists and enforces), and invitations exist
with a genuinely safe token design.

## Remaining work

Distributed rate limiting (release gate before horizontal scaling), password
reset and MFA (both blocked on an email provider), physical-device testing,
LCP/CLS/INP measurement, GDPR erasure.
