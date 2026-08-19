# ADR-0044 — One definition of "what is the landing path for this URL?"

**Status:** Accepted
**Date:** 2026-08-19

## Context

Two functions answered that question and disagreed. The one on the live write
path was the permissive one, and the dead one's own comment described the defect
the live one had.

- `toPath` — `packages/forms/src/tracking/sanitise.ts`. **Live.**
  `submit.ts` → `sanitiseContext` → `toPath`, writing
  `acquisitions.landing_path`. It called `new URL(value, base)` and trusted it to
  throw.
- `splitLandingUrl` — `packages/contracts/src/crm/provenance.ts`. **No callers**
  (dev log 0024). It carries a shape check applied _before_ the parse.

`new URL(x, base)` does not throw on the inputs that matter. It **resolves** them
against the base.

### Re-measured this session, not recalled

The 13-input table from dev log 0024 reproduces exactly — **7 disagreements**:

| input                     | `toPath` (live)             | `splitLandingUrl` |
| ------------------------- | --------------------------- | ----------------- |
| `::::`                    | `/::::`                     | `null`            |
| `javascript:alert(1)`     | `alert(1)`                  | `null`            |
| `mailto:a@b.test`         | `a@b.test`                  | `null`            |
| `tel:+61400000000`        | `+61400000000`              | `null`            |
| `data:text/html,<b>x</b>` | `text/html,<b>x</b>`        | `null`            |
| `not a url at all`        | `/not%20a%20url%20at%20all` | `null`            |
| `../../etc/passwd`        | `/etc/passwd`               | `null`            |

⚠️ **And the table was incomplete.** Widening the corpus found **seven more**:
`ftp://e.test/x` → `/x`, `file:///etc/passwd` → `/etc/passwd`, `about:blank` →
`blank`, `chrome://settings` → `/`, `vbscript:msgbox(1)` → `msgbox(1)`,
`javascript:void(0)` → `void(0)`, `C:\Windows\system32` → `\Windows\system32`.

Measured through `sanitiseContext` rather than through the function, because what
matters is what is **stored**: each of these reached `acquisitions.landing_path`
as written above. `toPath` also governs `submissionPath`, so both columns were
affected.

⚠️ **Eight of those fourteen values do not begin with `/`.** A column called
`landing_path` held `alert(1)`, `a@b.test`, `+61400000000`, `blank`,
`msgbox(1)`, `void(0)`, `text/html,<b>x</b>` and `\Windows\system32`.

### What was NOT established

Dev log 0024 did not determine whether a stored landing path reaches any context
where it would be interpreted rather than displayed, and **neither did this
work**. No such path was looked for and none is claimed to exist or not exist.
This is recorded as a data-quality defect on that evidence. `landing_path` is
`z.string().trim().max(512)` and is written, not evaluated, by everything
examined here — which is a statement about what was examined, not a clearance.

## ⚠️ §5 does not bind here, which is why this needed deciding

"URL identity is singular" is written for the **crawler**: the frontier, links,
canonicals, redirects and sitemaps must not disagree about what "the same page"
means. This is the forms/CRM path, so the invariant does not reach it.

The _failure mode_ reaches it anyway. Two functions answering one question, one
live and one dead, is how the live one drifts without anyone noticing — and it
drifted toward permissive, which is the direction that stores rubbish. The
invariant is not being extended by fiat; the same argument that justifies it for
the crawler happens to hold here, and that is the reason, not the rule.

## Decision

**One shared step, two callers that keep their own jobs.**

```ts
// packages/contracts/src/crm/provenance.ts
export function landingPathOf(rawUrl: string): string | null;
```

Shape check **before** the parse — an absolute `http(s)` URL or a rooted path, or
`null`. Both `splitLandingUrl` and `toPath` call it.

### ⚠️ Why not "make the live path call `splitLandingUrl`"

That was the obvious reading of "one normaliser" and it is wrong on three
measured counts:

1. **It returns UTM parameters the live path already has from elsewhere.** The
   brief asked this to be checked before assuming the shapes are
   interchangeable. Verified: `submissionContextSchema` carries `landingPath`,
   `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent`, `gclid` and
   `fbclid` as **independent fields**, and the tracker
   (`apps/web/scripts/track.src.js`) reads them separately —
   `window.location.pathname` for the path, `params.get('utm_*')` for the rest.
   Routing the path through `splitLandingUrl` would create a second, competing
   source for values that already arrive on their own.
2. **The caps differ.** `splitLandingUrl` truncates at `MAX_URL_LENGTH` (2,048);
   the column and the schema bound `landingPath` at 512.
3. **`toPath` also governs `submissionPath`**, which is not a landing URL and has
   no UTMs to split.

So the two functions are not duplicates in purpose. They are duplicates in
exactly one step — deciding what counts as a path — and that step is what is now
shared.

### ⚠️ Why not delete `splitLandingUrl`

It is dead, and dev log 0024 corrected its docstring rather than removing it.
Deleting it would take the shape-check decision with it — the thing that turned
out to be right. It now delegates that decision rather than owning a second copy
of it, so being dead no longer means being divergent.

### Why not "two documented behaviours"

The brief offered this. Rejected: the divergence **is** the defect. Documenting
that two functions disagree does not stop the next author reaching for whichever
one is nearer, and the nearer one was the permissive one for the whole life of
the live path.

## The differential

⚠️ This changes what lead capture writes.

| corpus                                            | inputs | changed |
| ------------------------------------------------- | -----: | ------: |
| realistic — what `window.location.pathname` sends | **21** |   **0** |
| hostile                                           | **14** |  **14** |
| empty / whitespace                                |  **3** |   **0** |

**Previously stored, now rejected: 14. Previously rejected, now stored: 0.**

The change is strictly one-directional — more restrictive, never less. Nothing a
real browser sends is affected: the realistic corpus includes `/`, deep paths,
percent-encoded and non-ASCII paths, query strings, protocol-relative and
absolute forms, and a 250-segment path, and **not one of them changes**.

### A rejected landing path does not fail the acquisition

Required by the brief and asserted at the database. `toPath` returns `undefined`,
`sanitiseContext` omits the field, `submit.ts` spreads
`...(context.landingPath ? { landingPath } : {})`, and the acquisition is written
with `landing_path` null. Seven integration tests submit a hostile landing path
and assert both `result.kind === 'accepted'` and `row.landingPath === null` — a
malformed referrer is ordinary traffic, not an error.

## Alternatives considered

**Add the shape check to `toPath` and leave `splitLandingUrl` alone.** The
minimal fix, and it fixes the live defect. Rejected because it leaves two copies
of the decision — the state that produced this ADR — and the next divergence
would be as invisible as this one was.

**Delete `splitLandingUrl`.** Above.

**Make the live path call `splitLandingUrl`.** Above, with the measurement.

**Two documented behaviours.** Above.

**Reject anything whose resulting pathname does not start with `/`.** A weaker
version of the shape check that would still have accepted `::::` → `/::::` and
`../../etc/passwd` → `/etc/passwd`. It is asserted as an additional property
rather than used as the rule.

**Put `landingPathOf` in `@growth-os/forms`.** Rejected on direction:
`contracts` is the shared layer and `forms` already imports from it; the reverse
edge does not exist and should not be created for this.

## Consequences

### Positive

- One definition of the question, called by both, with a property test asserting
  they still agree on every input in the corpus.
- Fourteen measured shapes stop reaching `acquisitions.landing_path` and
  `submission_path`.
- The stored value is now always a path — asserted as an invariant, where before
  8 of 14 hostile values were not.

### Negative

- **A cross-package call on the hot submission path.** `forms` now imports
  `landingPathOf` from `contracts`. The edge already existed for types; this
  makes it a runtime dependency for two fields per submission.
- **Attribution is lost where it was previously wrong.** A client posting
  `mailto:a@b.test` as a landing path used to get `a@b.test` recorded; it now
  gets nothing. That is the intended direction, but it is a real reduction in
  what is stored for a non-browser client.
- `splitLandingUrl` is still dead. It is now dead **and consistent**, which is
  better, and it is still a function nothing calls.
- The regex `/^https?:\/\//i` moved rather than being deduplicated. Three other
  copies remain and are their own brief.

## Verification

**18 new tests** — 11 unit in `public-path.test.ts`, 7 integration in
`lead-capture.integration.test.ts`.

**15 were observed red before the change**: 8 unit, and 7 integration confirmed
by reverting only the two source files to `d3eedc9` while keeping the tests, then
restoring.

Properties asserted rather than described:

- `toPath` and `splitLandingUrl` **agree on accept/reject and on the path for
  every input** in a 15-case corpus — the divergence cannot return silently.
- **Anything `toPath` returns starts with `/`**, over a 25-case corpus.
- The negative control: nine shapes a real browser sends are unchanged.

Suite: **989 passed / 223 skipped (1212)**, against 971 / 215 (1186) before. With
`TEST_DATABASE_URL` set, the integration project runs **223 passed**. 29 boundary
probes.

## Related

- [ADR-0028](ADR-0028-attribution-storage.md) — what the tracker stores, and why it is path-and-origin only
- [ADR-0012](ADR-0012-provenance-model.md) — provenance and confidence
- [dev log 0024](../development-log/0024-three-claims-the-code-does-not-keep.md) — where the disagreement was found
- [dev log 0025](../development-log/0025-one-landing-path-normaliser.md) — this work
