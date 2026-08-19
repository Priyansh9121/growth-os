# 0025 — One landing-path normaliser, and a table that was seven short

**Date:** 2026-08-19 · **Stage:** 4

## Objective

One landing-path normaliser. Two functions answered "what is the landing path for
this URL?" and disagreed about 7 of 13 inputs; the one on the live write path was
the permissive one. Dev log 0024's only remaining finding on a live write path.

## Initial state

Verified, not recalled: `d3eedc9`, tree clean, `verify:all` exit 0 at **971
passed / 215 skipped (1186)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Re-measured before acting (§0)

The 13-input table reproduces **exactly** — same 7 disagreements, same values.

⚠️ **And it was incomplete.** Widening the corpus found **seven more** shapes
`toPath` accepted and stored:

| input                 | stored as           |
| --------------------- | ------------------- |
| `ftp://e.test/x`      | `/x`                |
| `file:///etc/passwd`  | `/etc/passwd`       |
| `about:blank`         | `blank`             |
| `chrome://settings`   | `/`                 |
| `vbscript:msgbox(1)`  | `msgbox(1)`         |
| `javascript:void(0)`  | `void(0)`           |
| `C:\Windows\system32` | `\Windows\system32` |

Fourteen in total, and **eight of them do not begin with `/`**. A column called
`landing_path` held `alert(1)`, `a@b.test`, `+61400000000`, `blank`, `msgbox(1)`,
`void(0)`, `text/html,<b>x</b>` and `\Windows\system32`.

Measured through `sanitiseContext`, not through `toPath`, because §6 asks what is
**stored**. Two further facts that only showed up that way: `toPath` also governs
`submissionPath`, so both columns were affected; and an empty or whitespace value
already caused the field to be omitted entirely, which is the behaviour a
rejection needed to inherit.

### What was NOT established, and still is not

0024 did not determine whether a stored landing path reaches a context where it
would be interpreted rather than displayed. **Neither did this.** No such path was
searched for. Everything examined writes the column and does not evaluate it,
which is a statement about what was examined and not a clearance.

## The decision, and why the obvious reading of the brief was wrong

The brief offered "one normaliser, or two documented behaviours". The obvious
form of "one normaliser" — make the live path call `splitLandingUrl` — is wrong
on three counts, and the brief asked for the first to be checked before
assuming:

1. **`splitLandingUrl` returns UTM parameters the live path already has.**
   Verified: `submissionContextSchema` carries `landingPath` and the five UTMs
   and both click ids as **independent fields**, and the tracker reads them
   separately — `window.location.pathname` for the path, `params.get('utm_*')`
   for the rest. Routing the path through `splitLandingUrl` would create a
   second, competing source for values that already arrive on their own.
2. **The caps differ** — 2,048 vs the column's 512.
3. **`toPath` also governs `submissionPath`**, which is not a landing URL and has
   no UTMs to split.

So the two are **not duplicates in purpose**. They are duplicates in exactly one
step — deciding what counts as a path — and that is what now lives in
`landingPathOf`, in `contracts`, called by both.

⚠️ **§5 does not bind here and that is the point.** "URL identity is singular" is
written for the crawler. This is forms/CRM, so the invariant does not reach it —
but the failure mode does, and it is the reason rather than the rule. Two answers
to one question, one live and one dead, is how the live one drifts unnoticed. It
drifted permissive.

## The differential

| corpus                                            | inputs | changed |
| ------------------------------------------------- | -----: | ------: |
| realistic — what `window.location.pathname` sends | **21** |   **0** |
| hostile                                           | **14** |  **14** |
| empty / whitespace                                |  **3** |   **0** |

**Previously stored, now rejected: 14. Previously rejected, now stored: 0.**
Strictly one-directional.

The realistic corpus includes `/`, deep paths, percent-encoded and non-ASCII
paths, query strings, protocol-relative and absolute forms and a 250-segment
path. **Not one changes** — the tracker sends `window.location.pathname`, which
always starts with `/`, so the shape check is invisible to every legitimate
submission.

**A rejected landing path does not fail the acquisition.** `toPath` returns
`undefined` → `sanitiseContext` omits the field → `submit.ts` spreads it
conditionally → the row is written with `landing_path` null. Seven integration
tests assert both `result.kind === 'accepted'` and `row.landingPath === null`,
because a malformed referrer is ordinary traffic.

## Testing

**18 new tests** — 11 unit, 7 integration. `verify:all` exit 0: **989 passed /
223 skipped (1212)**, against 971 / 215 (1186) at the start. With
`TEST_DATABASE_URL` set the integration project runs **223 passed**. 29 boundary
probes.

**15 observed red before the change.** The 8 unit ones failed immediately. For
the 7 integration ones — the ones that matter, because they assert the column —
the two source files were reverted to `d3eedc9` with the tests kept, the suite
re-run to confirm exactly those 7 failed, and the fix restored. The negative
control passed in both states, which is what makes it a control.

Properties, not descriptions:

- `toPath` and `splitLandingUrl` agree on accept/reject **and** on the path for
  every input in a 15-case corpus. The divergence cannot come back quietly.
- Anything `toPath` returns **starts with `/`**, over a 25-case corpus — the
  invariant 8 of the 14 hostile values violated.

## The correction-block rule

`docs/decisions/README.md` rule 2 now carries an exception: an Accepted ADR that
states something factually wrong about **what is implemented** may take a dated
correction block beneath its Status line, body untouched.

The distinction is between a decision someone changed their mind about — which
supersedes, and whose old reasoning stays readable because it was right at the
time — and a sentence that was **never** right. Superseding the second misfiles
it as a reversal; leaving it alone means the next reader believes a control is in
force when it is not. ADR-0023 carries the first one, added as a judgement call
in 0024 before the rule existed. This formalises it.

## Files

```
packages/contracts/src/crm/provenance.ts            landingPathOf; splitLandingUrl delegates
packages/forms/src/tracking/sanitise.ts             toPath delegates
packages/forms/src/public/public-path.test.ts       11 tests
packages/forms/src/lead-capture.integration.test.ts 7 tests
docs/decisions/README.md                            rule 2 exception
docs/decisions/ADR-0044-one-landing-path-normaliser.md
docs/development-log/0025-one-landing-path-normaliser.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Remaining work

Dev log 0018's list. Nothing remaining is on a live write path.

1. **Four `/^https?:\/\//i` copies disagree.** One moved into `landingPathOf`
   with this work rather than being deduplicated; three remain
   (`sites/origin.ts`, `forms/tracking/sanitise.ts` `toOrigin`,
   `contracts/crm/provenance.ts` elsewhere). 0018 measured that given
   `\thttps://evil.test` the four return three different answers, and recorded
   that no security boundary crosses there — a data-quality defect.
2. `fieldTarget` (`contracts/forms/schemas.ts`) has no `.max()` and accepts a
   200 KB value into stored config.
3. The CRM LIKE escaper misses `\`, which affects `countTracesOf` — the helper
   the integration suite uses to prove GDPR erasure, failing in the direction
   that looks green.
4. `verification.ts` inherits an 8 MB body cap where its comment says 1 MB.
5. The client-side email regex, as a length guard.

⚠️ Two open items that are not defects but are worth not losing:

- **`splitLandingUrl` is still dead.** It is now dead and consistent rather than
  dead and divergent, which was the goal, but nothing calls it.
- The local development database is at migration 0007 (from 0023), so the crawl
  schema has still only ever existed inside a test harness.
