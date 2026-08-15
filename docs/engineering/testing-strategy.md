# Testing Strategy

**Status:** Implemented — Stage 2 brought the suite to 210 unit + 36 integration + 11 component + 29 E2E.

## The principle

> **Test the negatives.** A passing happy path proves almost nothing about a
> security control. "User A can read workspace A" would still pass if the guard
> returned `true` unconditionally.

The majority of the authorization and isolation tests assert that access is
**denied**.

## Three projects

Split so a contributor without PostgreSQL can still run the fast, deterministic
majority.

| Project       | Environment | Needs a DB?                                            | Runtime |
| ------------- | ----------- | ------------------------------------------------------ | ------- |
| `unit`        | node        | no                                                     | ~0.4 s  |
| `integration` | node        | yes — **skips itself** if `TEST_DATABASE_URL` is unset | ~1.5 s  |
| `web`         | jsdom       | no                                                     | ~1.7 s  |

Skipping rather than failing is deliberate: a missing database should give you
a reduced suite, not a broken checkout.

## What each layer covers

**Unit** — pure logic with no I/O: authorization guards, the open-redirect and
CSRF helpers, password hashing, the transition state machine, and design-token
contrast. All exhaustive, all fast.

**Integration** — real PostgreSQL: the full login sequence, and tenant
isolation connected as a **restricted non-owner role**. That role is the whole
point; superusers and table owners are exempt from RLS, so testing as one would
make every isolation assertion pass vacuously.

**Component** — jsdom: form accessibility, keyboard operation, ARIA state,
focus management, error announcement.

## Notable tests, and why they exist

| Test                                                    | Protects against                    |
| ------------------------------------------------------- | ----------------------------------- |
| Unknown-email and wrong-password messages are identical | Account enumeration                 |
| The dummy verify takes comparable time to a real one    | Timing-based enumeration            |
| A `SELECT *` with no WHERE returns only one tenant      | The mistake RLS exists to survive   |
| An unscoped transaction returns **nothing**             | Fail-closed isolation               |
| A cross-tenant INSERT is rejected                       | The `WITH CHECK` hole               |
| The tenant setting is empty after a transaction         | `SET LOCAL` leaking across the pool |
| RLS is both `ENABLED` and `FORCED`                      | The table-owner exemption           |
| 12 open-redirect payload shapes                         | Credential-harvesting bounce        |
| Origin check fails closed on missing headers            | CSRF bypass                         |
| Contrast ratios computed from real token values         | Silent a11y regression              |
| Every phase/event pair in the transition machine        | Illegal states, stuck animations    |
| `FORCE_COMPLETE` reachable from every phase             | A user trapped by an animation bug  |

## Meta-tests: testing the tests

Two scripts exist because **a silently misconfigured check is worse than no
check** — it manufactures confidence.

- `verify-boundaries.mjs` writes deliberately illegal imports and asserts lint
  **fails**. It caught `eslint-plugin-boundaries` passing every violation.
- `verify-gitignore.mjs` asserts no first-party source is hidden. It caught
  unanchored `coverage/` and `out/` rules before they hid anything.
- `check-bundle-budget.mjs` measures what a browser actually downloads per
  route, rather than trusting a build manifest.

### What the E2E suite caught that nothing else could

A stacking-context bug: the top bar's `z-30` ordered it only within its wrapper
`<div>`, so page content painted over the account dropdown. Every unit and
component test passed — jsdom has no layout. A real browser found it on the
first run.

## Not yet built

| Layer                   | Status                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| End-to-end (Playwright) | Config not yet added. The Stage 1 flows were verified manually and recorded in [development-log/0005](../development-log/0005-verification-and-measurement.md) |
| Visual regression       | Deferred until the design system stabilises; screenshot tests on a moving design are pure noise                                                                |
| Load / performance      | Stage 22                                                                                                                                                       |
| Coverage thresholds     | Deliberately none. A percentage target rewards testing trivial code; the negative-path tests above are the real measure                                        |

## Conventions

Co-locate unit tests with source (`x.ts` → `x.test.ts`). Integration tests use
`*.integration.test.ts`. Cross-package tests live in `tests/integration/`.
Name the behaviour and the reason, not the function: _"DENIES a workspace the
actor has no membership in"_, not _"requireWorkspaceAccess works"_.
