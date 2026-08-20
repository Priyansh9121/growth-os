# 0043 — The browser gate, and two things three dev logs got wrong about it

**Date:** 2026-08-21 · **Stage:** 4

## Objective

Get the Playwright suite into the standard gate, so it can no longer be
forgotten. Carried since [0040](0040-opening-a-browser.md), repeated in
[0041](0041-spending-the-accent.md) and [0042](0042-the-build-was-never-broken.md).

## Initial state

Verified, not recalled: `35543c6`, tree clean, `0 0` against origin, remote
PRIVATE, PostgreSQL accepting on 55432. `verify:all` exit 0 at **1368 passed /
321 skipped (1689)** in **55 s**, 29 boundary probes.

## ⚠️ Two findings that corrected the brief before any code

### 1. CI has been running the e2e suite all along

`.github/workflows/ci.yml` has a dedicated `e2e` job — PostgreSQL service,
Chromium install, `npm run e2e`, HTML report uploaded on failure — on **every
push to `main` and every pull request**.

Dev logs 0040, 0041 and 0042 each recorded "the e2e suite is not in a gate" and
listed gating it as outstanding. **All three were wrong**, and I wrote all
three. The suite was never ungated; it was ungated _locally_. What this session
actually adds is pre-push feedback, which is worth having — but it is a smaller
claim than the one the brief makes.

### 2. It would not have caught the bugs that motivated it

The 71 tests cover auth, CSP, CRM, lead capture, lifecycle and tenant
isolation. **None test themes, colour or contrast.**

0040's cascade bug (three of five themes rendering as a fourth) and 0041's
class-merging bug (every primary button at 1.47:1 contrast) were found by
**bespoke Playwright probes written in those sessions**, not by this suite.
Adding it to any gate would not have surfaced either.

The gate is still worth having — it is regression cover for what _is_ tested.
But the causal story in the brief, and in my own three previous logs, does not
survive measurement.

## The decision: beside the migrations check, not inside `verify:all`

§7 says the migrations-from-zero check stays out of `verify:all` because
_"verify:all cannot run it — it needs a database — so folding it in would delete
the check rather than inherit it."_

**That reasoning applies to e2e harder.** It needs a database, a production
build **and** a browser. Folding it in would either fail the standard gate on
every machine without PostgreSQL, or force a self-skip — producing a browser
gate that reports green having run no browser.

So `verify:e2e` is a sibling in the same **database tier**, and `verify:all` is
untouched and still database-free. AGENTS.md §7's Definition of Done gains it as
item (3), scoped to changes that could reach a browser and requiring an explicit
statement when skipped.

### ⚠️ It fails; it never skips

The preflight checks the database and the browser and stops with an actionable
message. Proven both directions:

| Condition            | Result                                      |
| -------------------- | ------------------------------------------- |
| Database unreachable | **exit 1**, naming host:port and the remedy |
| Database reachable   | **71 passed, exit 0**                       |

This is deliberately the opposite trade from the integration project, which
self-skips so a developer without PostgreSQL still gets a useful `verify:all`.

## One shared database URL, not a third copy

The E2E database literal was already duplicated in `playwright.config.ts` and
`tests/e2e/global-setup.ts`. A preflight with its own third copy could pass
while the suite connected somewhere else — **a check that lies**, which is worse
than no check, and the same drift §7 warns about.

`tests/e2e/database-url.mjs` now holds it once and all three import it. `.mjs`
because two consumers are TypeScript compiled by Playwright's bundler and the
third is plain Node; that is the one shape all three load without a build step.

## Measured cost

Not estimated:

| Gate          | Cost                                     |
| ------------- | ---------------------------------------- |
| `verify:all`  | **51 s** (unchanged, database-free)      |
| `verify:e2e`  | **74 s** warm `.next`                    |
| full e2e cold | **91 s** (includes the production build) |

A session doing both now spends roughly **two minutes**.

## ⚠️ An observed flake, reported not fixed

The full suite failed once in three runs, on `lifecycle.spec.ts:231`
_"defines a tag and a custom field, then applies both"_ — expected `"Terrace"`,
received `""`.

It passes **3/3 in isolation** and both subsequent full runs were green
(71 passed each), so it is a suite-context race rather than a product bug.

Gating on a suite that fails 1-in-3 would erode trust in the gate, so this is
recorded prominently rather than buried. Diagnosing it is test work this brief
put out of scope, and three runs is too small a sample to characterise a race
responsibly. **It needs its own brief.**

Setting `retries` locally was considered and rejected: the config already
retries once under CI, and adding it locally would hide exactly the signal a
gate exists to give.

### ⚠️ And a second flake, in the gate everything already depends on

`verify:all` failed once during this session on
`packages/auth/src/password.test.ts` — _"takes comparable time to a real
verification"_, the argon2 timing test that defends against account
enumeration. It asserts `dummyMs < realMs * 4`; it measured **90.49 ms against a
83.86 ms ceiling**.

It passed **3/3 in isolation** and `verify:all` was green on the next run. It
fired while this machine was simultaneously running production builds and a
browser suite, which is exactly the load a wall-clock assertion is vulnerable to.

Reported rather than touched. §6 forbids weakening a failing test to get green,
and the test is defending something real — but a timing assertion in the
**standard** gate is a latent source of false failures, and it will get worse
now that a session is expected to run a browser suite alongside it. It belongs
with the flake above in its own brief.

## Also corrected

`docs/engineering/testing-strategy.md` listed **"End-to-end (Playwright) —
Config not yet added"** under _Not yet built_. The config exists, CI runs it, and
71 tests pass. That row has been wrong since the suite landed.

## Testing

- `verify:all` exit 0: **1368 passed / 321 skipped (1689)**, unchanged from
  `35543c6`. 29 boundary probes. (One intermediate run failed on the argon2
  timing flake above and was green on re-run — recorded rather than hidden.)
- `verify:e2e` exit 0: **71 passed**.
- Preflight failure path: exit 1 against an unreachable database.

## What is unverified

**I did not run the e2e suite on a machine without PostgreSQL**, only against a
deliberately-wrong URL on this one. The preflight's TCP check is the same code
path either way, but "no database installed at all" is not literally what I
tested.

**The flake has a three-run sample.** I am reporting 1-in-3 because that is what
I observed, not because I believe that is the true rate.

## Remaining work

1. **Diagnose both flakes.** Now the top item — a gate that fails
   intermittently is worse than one that is remembered manually, and this
   session observed two: the `lifecycle.spec.ts` race, and the argon2 timing
   assertion in `verify:all` itself. The second matters more, because it can
   fail any session on a loaded machine.
2. **Decide the signed-out palette** — track the default, or pin it (0040).
3. **`growth-warm`'s accent/attention separation** — amber-on-amber at 27° (0041).
4. **`--color-viz-*` per theme**, before Stage 5 ships charts. Still latent.

⚠️ **Migrations, measured not carried:** disk **14**, dev DB **14**, test DB
**14** — level, unchanged since 0041.
