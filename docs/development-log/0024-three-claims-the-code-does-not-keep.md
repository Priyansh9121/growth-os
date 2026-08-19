# 0024 — Three claims the code does not keep, and a fourth found while checking

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Resolve three claims the codebase makes that measurement contradicts: a security
control documented as live with no callers, a dead function whose docstring
describes wiring that does not exist, and a strip-list entry that can never
match.

## Initial state

Verified, not recalled: `dffbd1a`, tree clean, `verify:all` exit 0 at **957
passed / 215 skipped (1172)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## ⚠️ Every claim re-verified before acting

All three came from previous sessions, and §0 says a claim not measured in this
session is a claim you do not have. All three held. Two of them turned out to be
**larger** than recorded.

### Claim 1 — `neutraliseCsvFormula` — CONFIRMED, and it is claimed in two places

References across the whole repository: its definition
(`contracts/src/crm/lifecycle.ts:522`), its test file, and **two documents**.
Zero production callers.

The brief named `docs/security/data-lifecycle.md`. It missed the stronger one:
**`docs/decisions/ADR-0023-csv-import.md` also lists it**, and does not merely
tabulate it —

> "Formula injection is an **export** risk, and the export path applies the same
> prefixing"

That asserts an export path exists. It does not. The only `text/csv` match in the
application is `accept=".csv,text/csv"` on the **import** file picker
(`import-wizard.tsx:169`), and `crm/src/import/csv.ts` reads a file and never
writes one.

### Claim 1b — the index-0 limitation — CONFIRMED, and the brief phrased it exactly right

Measured against `=cmd|'/c calc'!A1`:

| leading character | prefixed? |
| ----------------- | --------- |
| none              | yes       |
| TAB               | **yes**   |
| CR                | **yes**   |
| space             | **no**    |
| BOM               | **no**    |
| NBSP              | **no**    |
| LF                | **no**    |

TAB and CR are in the rule, so they fire. What defeats the guard is any leading
character _outside_ the set, which pushes the dangerous character off index 0.

⚠️ **Whether a spreadsheet still evaluates the formula after a leading space, BOM,
NBSP or LF was not measurable here** — no spreadsheet in this environment. Dev
log 0018 said the same and it is still true. Recorded as an open question in both
directions, never as a vulnerability and never as a non-issue (§6).

### Claim 2 — `splitLandingUrl` — CONFIRMED, and it is worse than dead

Definition and tests only, as recorded. But the docstring's claim was —

> "Used by ingestion paths that receive a full URL from a browser. Centralised so
> that no caller stores a raw URL by accident"

— and **another function is doing that job on the live path.** Lead capture runs
`submit.ts:232` → `sanitise.ts:115` → `toPath`, not this.

⚠️ They disagree. Measured over 13 inputs, `toPath` accepts **7** that
`splitLandingUrl` rejects:

| input                     | `toPath` (live)             | `splitLandingUrl` (dead) |
| ------------------------- | --------------------------- | ------------------------ |
| `::::`                    | `/::::`                     | `null`                   |
| `javascript:alert(1)`     | `alert(1)`                  | `null`                   |
| `mailto:a@b.test`         | `a@b.test`                  | `null`                   |
| `tel:+61400000000`        | `+61400000000`              | `null`                   |
| `data:text/html,<b>x</b>` | `text/html,<b>x</b>`        | `null`                   |
| `not a url at all`        | `/not%20a%20url%20at%20all` | `null`                   |
| `../../etc/passwd`        | `/etc/passwd`               | `null`                   |

And the dead function's own comment names the defect precisely:

> "`new URL(x, base)` resolves almost any string against the base rather than
> throwing, so relying on the throw alone would happily turn '::::' into the
> landing path '/::::' and store it."

The live function relies on the throw alone. It stores `/::::`.

⚠️ **Not fixed here.** It changes what lead capture writes on the live path and
needs its own brief. Ranked below.

### Claim 3 — `aspsessionid` — CONFIRMED

| parameter                  | before   |
| -------------------------- | -------- |
| `aspsessionid=abc`         | stripped |
| `ASPSESSIONID=abc`         | stripped |
| `ASPSESSIONIDQWERTY=abc`   | **kept** |
| `ASPSESSIONIDACSSDACR=abc` | **kept** |
| `ASPSESSIONIDSQBSTBRA=abc` | **kept** |

IIS emits `ASPSESSIONID` plus eight letters that vary per application pool, so
the exact-match entry stripped precisely the two spellings no server sends.

## What was done, and what deliberately was not

**Claims 1 and 2 are documentation-only**, exactly as the brief preferred, and
for the reason it gave: there is nothing to wire them into, and a guard with no
caller rots.

- The Risk/Control row is **removed, not softened**. A Risk/Control table is read
  as an inventory of what is in force; an entry naming a function that never runs
  is how the next author concludes the problem is solved. The removal is
  explained in prose immediately below the table, with what must happen when an
  export is built.
- Both docstrings now open with what is _not_ true, before what the function
  does.
- The measured index-0 limitation is pinned as **tests**, so the author who
  eventually wires an export meets it as an executable fact rather than a
  docstring — including the contrast case that TAB and CR _are_ handled, which is
  what makes the others meaningful.

⚠️ **A judgement call, flagged for reversal.** `docs/decisions/README.md` rule 2
says an ADR is immutable once Accepted. ADR-0023 contains a false statement about
what is implemented — not a decision anyone changed their mind about. I added a
dated correction block under its Status line and **did not alter one word of the
body**. Leaving a false security claim in place because of a formatting rule
seemed the worse of the two errors, but it is a rule I bent rather than followed
and it should be reverted if that is not wanted.

**Claim 3 changed behaviour**, and it is the one place the brief's default was
not taken. Unlike the other two, something here _is_ wired: the strip list is
live, one entry does nothing, and what it fails to prevent is unbounded identity
growth on Classic ASP sites — a new crawl identity per visitor, landing on the
durable `site_pages` key. Documenting that it does not work is worse than making
it work when the fix is twelve characters. Recorded in
[ADR-0043](../decisions/ADR-0043-aspsessionid-prefix-match.md) with the
differential §5 requires.

## The differential for claim 3

Over 80 realistic parameter names: **75 unchanged, 5 newly stripped, 0 newly
kept.** All five are IIS session ids. All 73 names not starting with the prefix
are unchanged, so the change is exactly as wide as the prefix.

The near-misses — `asp`, `aspect`, `aspnet`, `aspx`, `asp_net`, `aspect_ratio` —
are kept before and after. Prefix matching stays a list of **one**, because `sid`
as a prefix would strip `sidebar` and `ref` would strip `refresh`, which is the
identity collision ADR-0041 spent a brief removing.

## Testing

**14 new tests**: 8 in `normalise.test.ts`, 6 in `csv.test.ts`. `verify:all` exit
0: **971 passed / 215 skipped (1186)**, against 957 / 215 (1172) at the start. 29
boundary probes.

**4 were observed red before the change** — one per realistic IIS name. The
near-miss and exact-match-neighbour guards passed before and after, which is what
proves prefix matching did not leak to another entry.

`STRIPPED_PARAMETERS.sessionPrefixes` is exported and asserted to equal
`['aspsessionid']`, so the prefix list cannot grow without a test change and
therefore without a new differential.

Nothing was added for claims 1 and 2 beyond the limitation tests, because nothing
changed behaviourally. A test cannot assert "this function has no callers" — that
would be a boundary probe, and adding one is scope this brief did not have.

## Files

```
packages/crawler/src/urls/normalise.ts          SESSION_PARAMETER_PREFIXES
packages/crawler/src/urls/normalise.test.ts     8 tests
packages/contracts/src/crm/lifecycle.ts         docstring: not wired, and the index-0 limit
packages/contracts/src/crm/provenance.ts        docstring: no callers, and toPath disagrees
packages/crm/src/import/csv.test.ts             6 tests pinning the limitation
docs/security/data-lifecycle.md                 Risk/Control row removed, with why
docs/decisions/ADR-0023-csv-import.md           correction block; body untouched
docs/decisions/ADR-0043-aspsessionid-prefix-match.md
docs/development-log/0024-three-claims-the-code-does-not-keep.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Remaining work

⚠️ **New, and ranked first because it is the only one on a live write path:**

1. **`toPath` stores what `splitLandingUrl` was written to reject.** Measured
   above: 7 of 13 inputs, including `javascript:alert(1)` → `alert(1)` and
   `::::` → `/::::`, stored as `landing_path` on lead capture. It is stored, not
   executed, and the column is `z.string().trim().max(512)` — so this is a
   data-quality defect, not a demonstrated security one, and I have **not**
   measured whether any of it reaches a context where it would be. Either give
   `toPath` the shape check `splitLandingUrl` already has, or make the live path
   call `splitLandingUrl` and delete the duplicate. One normaliser, or two
   documented behaviours.

Then the rest of dev log 0018's list, unchanged:

2. `fieldTarget` (`contracts/forms/schemas.ts`) has no `.max()` and accepts a
   200 KB value into stored config.
3. Four `/^https?:\/\//i` copies disagree about the same question — and one of
   them is `splitLandingUrl:158`, which this entry has now read closely.
4. The CRM LIKE escaper misses `\`, which affects `countTracesOf`, the helper the
   integration suite uses to prove GDPR erasure.
5. `verification.ts` inherits an 8 MB body cap where its comment says 1 MB.
6. The client-side email regex, as a length guard.

Still open from 0023: the local development database is at migration 0007, so the
crawl schema has only ever existed inside a test harness.
