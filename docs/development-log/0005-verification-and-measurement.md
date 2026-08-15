# 0005 — Verification, measurement and hardening

**Date:** 2026-08-15 · **Stage:** 1

## Objective

Verify that the controls described in the documentation actually work, measure
real performance rather than claim it, and fix what verification exposed.

**This entry is the most useful in the log**, because three of the things
verification found were checks that reported success while enforcing nothing.

---

## Finding 1 — The module boundary lint enforced nothing

**Symptom:** `eslint-plugin-boundaries` was configured, its rule was active in
the resolved config, and lint passed cleanly.

**Test:** wrote a deliberately illegal import (`packages/ui` → `@growth-os/database`)
and ran lint. **It passed.** Tried a relative-path variant
(`../../database/src/client`). **Also passed.** Enabling the plugin's debug
setting produced no output at all.

**Cause:** the plugin could not resolve workspace packages here. `@growth-os/*`
specifiers resolve through npm's `node_modules` symlinks to `exports` entries
pointing at TypeScript source, which its resolver treats as external.

**Why this matters more than the bug itself:** the architecture documentation
claimed boundaries were "mechanically enforced". They were not. A rule that
cannot fail is worse than no rule, because it manufactures confidence — and it
would have been discovered months later by an import that should never have
compiled.

**Fix:**

- Replaced with `no-restricted-imports`, which operates on the specifier
  **string** and needs no module resolution.
- **Removed the dependency entirely** rather than keep a decorative one.
- Wrote [`scripts/verify-boundaries.mjs`](../../scripts/verify-boundaries.mjs),
  which writes eight illegal imports, asserts lint **fails** on each, and
  cleans up.

```
✓ rejected: ui → database        ✓ rejected: database → auth
✓ rejected: ui → contracts       ✓ rejected: auth → ui
✓ rejected: contracts → database ✓ rejected: auth → next
✓ rejected: contracts → next     ✓ rejected: relative-path escape
All 8 module boundaries are enforced.
```

---

## Finding 2 — `.gitignore` would have hidden future source code

**Test:** wrote [`scripts/verify-gitignore.mjs`](../../scripts/verify-gitignore.mjs),
which probes plausible **future** source paths — the ones whose names collide
with common ignore patterns — and asserts they remain trackable.

**Two real hits**, in a `.gitignore` that had already been written carefully
with anchoring in mind:

| Rule        | Would have silently hidden                                                       |
| ----------- | -------------------------------------------------------------------------------- |
| `coverage/` | `packages/seo/src/coverage/` — **keyword coverage is a planned Stage 6 feature** |
| `out/`      | `packages/integrations/src/out/` — outbound webhooks                             |

Neither directory exists yet, which is exactly the point: caught before the
code existed, when the fix is one character. Caught afterwards, the symptom is
a colleague cloning the repository and finding a module missing.

**Fix:** anchored both (`/coverage/` plus per-workspace variants, `/out/`), and
anchored the report directories for the same reason. The probe list now covers
twelve such paths permanently.

---

## Finding 3 — The contrast claim in the design system was false

The design system asserts 4.5:1 for body text. The contrast test computes real
WCAG ratios from the token values and **found two light-theme failures**:

| Token                        | Measured | Required |
| ---------------------------- | -------- | -------- |
| `--color-signal` on white    | 4.29:1   | 4.5:1    |
| `--color-attention` on white | 4.44:1   | 4.5:1    |

Both were invisible by eye. Fixed by darkening the tokens
(`oklch(0.56 0.13 165)` → `oklch(0.52 0.12 165)`, and similarly for attention).

This is the argument for computing the ratios rather than asserting them in
prose: a documented contrast claim is not a control.

---

## Finding 4 — An unstated precondition on a public export

An integration test failed on email normalisation. Cause: `login()` assumed its
caller had already parsed input through `loginInputSchema`.

That is an unstated precondition on a public package export, and its failure
mode is silent and miserable — a user whose stored email is `sam@x.test` typing
`Sam@X.test` is told their password is wrong, with nothing in any log to
explain it. Future hosts (the Fastify API, the voice service) would hit it.

**Fix:** re-normalise inside `login()` using the same schema. The package
boundary is a trust boundary, so it validates its own input.

---

## Live end-to-end verification

Against a real server and a real seeded database. Every result below was
observed, not inferred.

| #   | Check                                    | Result                                                       |
| --- | ---------------------------------------- | ------------------------------------------------------------ |
| 1   | Unauthenticated `/dashboard`             | `307 → /login?next=%2Fdashboard`                             |
| 2   | Wrong password                           | `401` `"Email or password is incorrect."`                    |
| 3   | Unknown email                            | `401` **identical body**, differing only by correlation ID   |
| 4   | POST with foreign `Origin`               | `403 Request origin could not be verified`                   |
| 5   | POST with **no** `Origin`                | `403` — fails closed                                         |
| 6   | Valid sign-in                            | `200`, `#HttpOnly_` cookie set                               |
| 7   | Token at rest                            | 64-char hex digest, unrelated to the cookie value            |
| 8   | Authenticated dashboard                  | Renders workspace, **"Demo data"** banner, AI panel          |
| 9   | Sam → own workspace                      | `200 {role: owner, via: direct}`                             |
| 10  | **Sam → another tenant**                 | **`403`**, no indication whether it exists                   |
| 11  | Riley (agency, **zero membership rows**) | Reaches **2** client workspaces                              |
| 12  | Riley → Harbour Dental                   | `200 {role: admin, via: agency}`                             |
| 13  | Riley → a non-client workspace           | **`403`**                                                    |
| 14  | Ask Growth AI                            | `mode: offline`, `growth.getSnapshot`, `provenance: fixture` |
| 15  | **AI against another tenant**            | **`403`**                                                    |
| 16  | Audit trail                              | `via: agency` recorded distinctly from `direct`              |
| 17  | Secrets in audit metadata                | **0** actual secret or PII values                            |

Check 11 is the agency model working exactly as designed: transitive access
with no rows copied into `memberships`.

One check needed refinement: a naive scan for `%password%` in audit metadata
flagged one row. It was the literal reason code `bad_password` — a
classification, not credential material. Searching for actual secret _values_
returned zero. Recorded because the distinction matters when reading such a
scan.

Env validation also fired during this session, refusing to boot production with
`APP_URL=http://localhost`. **That is the validator working**, and it is
documented in [troubleshooting.md](../operations/troubleshooting.md) rather
than softened.

---

## Performance — measured, not claimed

```bash
cd apps/web && npx next build && npx next start --port 3111
curl -s http://localhost:3111/login   # sum gzip size of referenced chunks
```

| Metric                                     | Measured                         |
| ------------------------------------------ | -------------------------------- |
| Login initial JS                           | **252.5 KB gzip** (12 chunks)    |
| Dashboard initial JS                       | **260.8 KB gzip** (13 chunks)    |
| 3D lattice chunk                           | **228.9 KB gzip** (868.8 KB raw) |
| **three.js in the login's initial bundle** | **No**                           |
| **three.js on the dashboard**              | **No**                           |
| Login HTML                                 | 44.1 KB raw / 6.4 KB gzip        |

The two negatives are the important results: the lazy-loading architecture
works, so authentication never waits on 3D and the operator surface pays
nothing for it.

Both initial bundles **exceed the 250 KB budget** — by 1% and 4%. That is React
plus the Next.js runtime, not application code. Recorded as a real overage with
reduction paths in [performance-budget.md](../design/performance-budget.md),
rather than adjusting the budget to match reality.

LCP, CLS, INP and frame rate are **not measured**, and the budget document says
so explicitly instead of filling in plausible figures. They need a deployed
origin and physical devices.

---

## Result

All gates green: **116 tests** across 8 files (84 unit, 21 integration, 11
component), typecheck clean across five workspaces, lint clean, production
build succeeds, both safety verifiers pass.

## Remaining work

No end-to-end browser suite. No physical-device testing. No automated bundle
regression check. No CSP. Distributed rate limiting is a named release gate
before horizontal scaling.
