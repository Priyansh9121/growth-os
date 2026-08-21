# 0044 — Two flakes, both structural, neither found by re-running

**Date:** 2026-08-21 · **Stage:** 4

## Objective

Diagnose and fix the two flaky tests [0043](0043-the-browser-gate.md) observed
while wiring up the browser gate: the argon2 password-timing assertion in
`packages/auth`, and the intermittent `tests/e2e/lifecycle.spec.ts` failure
around tags and custom fields.

⚠️ **This entry covers both, and the first half was committed before it was
written.** The session that fixed the argon2 flake was interrupted immediately
after committing `88a4047` and never wrote its log — while having already
committed three source files citing `docs/development-log/0044-two-flakes.md`.
Those citations pointed at nothing, which §4 calls worse than no citation at
all. This file is that document, and closes the gap rather than leaving the
argon2 fix permanently undocumented.

## Initial state

Verified, not recalled: `88a4047`, tree clean, remote PRIVATE. `verify:all`
exit 0 at **1372 passed / 321 skipped (1693)**, 29 boundary probes.

Two of the brief's assumptions were false, both checked rather than taken on
trust:

- **`tests/e2e/__race-probe.spec.ts` did not exist**, and never had — the
  command that would have written it was blocked mid-turn before touching disk.
  `git status --untracked-files=all` was empty. Nothing to clean up.
- **The repository was one commit ahead of origin.** `88a4047` was committed and
  never pushed. `verify:all` was green at that HEAD, so it was pushed first — an
  unpushed commit is the worse state (§4).

---

## Flake 1 — argon2 timing (committed as `88a4047`)

### Pass/fail sampling said there was nothing there

0043 saw it fail once and warned its three-run sample proved nothing. Measured
properly: **20 isolated runs and 20 under CPU saturation, all 40 green.** The
flake would not reproduce on demand.

### The recorded numbers were the clue

0043 logged `dummyMs 90.49` against a ceiling of `83.86`. That ceiling is
`realMs * 4`, so `realMs` was **20.96 ms** — the real verification was _fast_,
not the dummy slow. Load alone cannot produce that shape.

### Root cause

`getDummyHash` memoised with `??=`, so the **first** `verifyPasswordDummy` of a
process performed a hash **and** a verify while `verifyPassword` performed a
verify alone. Measured across eight fresh processes:

| Call   | dummy / real ratio          |
| ------ | --------------------------- |
| first  | **1.68 – 2.35** (mean 2.07) |
| second | 0.79 – 1.11                 |
| third  | 0.93 – 1.01                 |

The test measures the first call, so it began at a structural ~2× and had only
2× of headroom before its 4× ceiling.

**The docblock above that code had said "Generated at module load" the whole
time. The code did the opposite.** It was also a real, if small, product
characteristic: the first "no such user" response after a boot cost roughly twice
a "wrong password" one — a timing difference between exactly the two branches
that constant exists to make indistinguishable. In the **safe** direction
(unknown-email slower, not faster) and one request per process, which is why
nobody noticed.

### Fix, and why the fix alone was not enough

The hash now starts at module load, non-blocking — argon2 runs on its own
threadpool, so import returns immediately. First-call ratio became
**0.98 – 1.35** (mean 1.19).

⚠️ **20 further isolated runs still produced one failure**: `realMs 7.97`,
`dummyMs 34.52`, ratio 4.33. A single sample of an ~8 ms operation is routinely
disturbed by a GC pause or a scheduler preemption.

So the test now takes the **median of five interleaved samples**. Both bounds are
**unchanged** at 0.25× and 4× — a strengthening, not a loosening (§6): a single
sample can fail spuriously _and_ pass spuriously, so one lucky pair could hide a
genuine divergence, whereas a median cannot be moved by one outlier in either
direction. Interleaving means load drifting mid-test moves both series together.
Across 20 fresh processes the median ratio sits in **0.86 – 1.26**.

`dummy-hash.test.ts` is new and **deterministic** — it counts calls into argon2
instead of timing them, so no clock is involved. Under the old lazy code two of
its four tests fail with _"the login path paid for the dummy hash"_.

### Post-fix rate

**20 isolated: 20 passed. 20 under load (1-minute average 12.19): 20 passed.**

---

## Flake 2 — `lifecycle.spec.ts` custom fields

### Pass/fail sampling was the wrong instrument, again

The previous attempt ran the affected tests **15 times at a load average of
28.9** and saw zero failures. This session did not try to reproduce it harder.
Locally the field-save PUT answers in ~10 ms, so `reload()` almost never wins;
the window only opens under real suite contention.

### Diagnosis: control the variable instead of chasing it

With an 800 ms delay routed onto `PUT /api/crm/contacts/*/fields`, run as a
temporary probe **inside the spec itself** so it could use the file's local
helpers:

| Sequence                                   | Result     |
| ------------------------------------------ | ---------- |
| `fill → blur → reload` (what the test did) | **FAILED** |
| `fill → blur → await response → reload`    | **PASSED** |

One run of each. That is the whole diagnosis.

`ContactCustomFields` commits on blur through
`onCommit={(value) => void save(definition.id, value)}` — deliberately **not**
awaited, so the field stays responsive while a spinner and a `role="status"`
"Saving …" message report progress. `blur()` returning means the request was
_started_. The `page.reload()` immediately after could tear it down mid-flight,
leaving the field empty on the reloaded page — precisely the
`expected "Terrace", received ""` that 0043 recorded.

**The product is not at fault and is unchanged.** Fire-and-forget with a visible
saving state is a deliberate pattern, and it already exposes two observable
signals. This was a test that used neither.

### ⚠️ Why it waits on the response, not on the spinner

The "Saving …" indicator is the obvious candidate and the wrong one. A fast save
can appear and vanish between polls, so _"wait until it is absent"_ is trivially
true **before the request has even begun** — a wait that closes nothing while
looking like a fix. Waiting for it to appear first reintroduces the same race in
the other direction.

`page.waitForResponse` is created **before** the action that triggers it, so it
cannot be missed however fast the server answers. Never a fixed sleep, which
narrows a window without closing it (§6).

### Both tests, not only the one that failed

`rejects a value that does not fit its type`, three lines below, had the
identical `fill → blur → reload` shape and the identical latent race.

### Post-fix rate

**20 runs under load (1-minute average 18.58): 20 passed, 0 failed.** Both fixed
tests also pass under the same 800 ms delay that made the old sequence fail
every time.

---

## ⚠️ A blocker, and a defect it exposed

The project's PostgreSQL — `gos_admin@127.0.0.1:55432` — was **down** at the
start of the second half. Two other clusters were listening (`5432`, `55433`),
neither with that role or the `growth_os*` databases, both refusing the project's
credentials. Docker was not running, and `infrastructure/docker-compose.yml` maps
`5432:5432`, which the native cluster already occupied.

The session stopped and asked rather than guessing at a cause it could not
observe.

**`verify:e2e`'s preflight — written in 0043 to fail loudly rather than discover a
missing database ninety seconds later — announced:**

```
▶ verify:e2e — database postgresql://growth_os:***@127.0.0.1:5432/growth_os_test reachable on 5432
```

and then failed seconds later inside `db:migrate`. **It only performs a TCP
handshake.** Something was listening on that port; it simply was not our
database — exactly the failure mode the preflight exists to prevent. Not fixed
here, and now the top remaining item.

## Testing

- `verify:all` exit 0: **1372 passed / 321 skipped (1693)**, 29 boundary probes.
- `verify:e2e` exit 0: **71 passed**, 70 s.
- Migrations: disk **14**, test DB **14**.

## What is unverified

**Zero failures in 20 runs is not proof of a zero flake rate**, for either fix.
What carries the confidence is not the count — it is that both mechanisms are
understood, and that each has a controlled experiment which fails
deterministically without the fix and passes with it.

**Neither original failure was reproduced.** Both were explained and then
demonstrated under controlled conditions. Those are different claims, and the
first was not achievable at this machine's latency.

## Result

Both flakes from 0043 are closed. No stray diagnostic file was created, and
three dangling `0044-two-flakes.md` citations in committed source now resolve.

## Remaining work

1. **`verify:e2e`'s preflight does a TCP handshake, not a database connection.**
   It reported a wrong cluster as "reachable". Provable immediately against ports
   5432 and 55433. Top item.
2. **Decide the signed-out palette** — track the default, or pin it (0040).
3. **`growth-warm`'s accent/attention separation** — amber-on-amber at 27° (0041).
4. **`--color-viz-*` per theme**, before Stage 5 ships charts. Still latent.
