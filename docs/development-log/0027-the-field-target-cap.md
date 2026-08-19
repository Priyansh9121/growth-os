# 0027 — The field target cap, and the length check that does not gate the pattern

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Give `fieldTarget` in `packages/contracts/src/forms/schemas.ts` a length cap, and
establish whether the same gap exists on any other zod field reaching stored form
config.

Dev log 0018's oldest open finding, carried through 0025 and 0026 because nothing
on a live write path depended on it.

## Initial state

Verified, not recalled: `4242da1`, tree clean, `verify:all` exit 0 at **1088
passed / 223 skipped (1311)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Re-measured before acting (§0)

The finding reproduces, and 0018 understated it in one respect: the value is not
just accepted, it is **stored at full length**, and 200,007 was never a ceiling.

| input                     | result                          |
| ------------------------- | ------------------------------- |
| `custom:` + 1,000 `a`     | PARSED, stored length 1,007     |
| `custom:` + 200,000 `a`   | PARSED, stored length 200,007   |
| `custom:` + 1,000,000 `a` | PARSED, stored length 1,000,007 |

There was no bound of any kind. 200,007 is simply the size 0018 tried.

### What it is not — traced rather than assumed

An unbounded pattern over hostile input reads like a timing defect. It is not:

- **The pattern is linear.** `^custom:[a-z][a-z0-9_]*$` costs 2.33 ms against
  4 MB. Proportional, no exponential case.
- **`mapped.customFields` is never consumed.** `submit.ts:374` slices the key off
  the target into a `customFields` record, and **nothing reads it.** Checked by
  enumerating every `mapped.` reference in the file: `identity`, `note` and
  `missingRequired` are all used; `customFields` is not. So an oversized target
  does not reach the CRM.
- **`target` is absent from `PublicFormFieldView`** by design, so it is never
  published to a browser.
- **Writing config requires an authenticated operator**, so this is not an
  anonymous path.

What remains is the real defect: unbounded strings in the `form_versions.fields`
`jsonb` column, whose rows are immutable version snapshots and are kept
permanently. A data-integrity defect, exactly as 0018 ranked it — and worth
saying plainly, because three of the four things above look like they make it
worse and each one measured smaller instead.

## ⚠️ The part that would have been got wrong by reading

0018 recorded, separately and in a different section, that **zod v4 runs every
check and collects all issues**, so `.max()` bounds what is _accepted_ and never
what is _examined_. The brief asked for that to be re-verified rather than
carried forward, and it holds on zod 4.4.3.

Two independent measurements:

- Instrumenting `RegExp.prototype.test`, `fieldKey` — which already has
  `.max(48)` — **ran its pattern against the full 200,000-character string**
  before reporting `too_big`.
- A 200,007-character target now produces **both** `too_big` and
  `invalid_format`, which is the same fact visible from the outside.

So the obvious fix — add `.max(55)` — would have stopped the value being stored
and left the pattern's cost proportional to operator-supplied input. The
quantifier is bounded as well:

| target size | `[a-z0-9_]*` | `[a-z0-9_]{0,47}` |
| ----------- | -----------: | ----------------: |
| 1 KB        |   0.00064 ms |       0.000145 ms |
| 100 KB      |    0.0579 ms |       0.000128 ms |
| 1 MB        |     0.579 ms |       0.000129 ms |
| 4 MB        |     2.331 ms |       0.000130 ms |

Flat from 1 KB to 4 MB — independent of input length, not merely small. End to
end through `formVersionConfigSchema`, for the same 1000× increase in input:
**672.6× before, 1.3× after.**

## The cap is derived, not chosen

`custom:<key>` exists to name a CRM custom field, so the longest useful target is
the prefix plus the longest key the CRM accepts: `7 + 48 = 55`.

That `48` was a bare literal inside `customFieldKey` in `crm/lifecycle.ts`.
Writing a second one in the forms schema would have recreated the exact condition
ADR-0044 and ADR-0045 were both written about, so it is now
`CUSTOM_FIELD_KEY_MAX_LENGTH`, exported from `crm/enums.ts` and used by both.

⚠️ **Scope note, stated rather than done quietly.** The brief scoped this to
`schemas.ts`. Extracting the constant also touches `crm/enums.ts` and
`crm/lifecycle.ts`. I judged that in scope because the cap is only correct if it
tracks the bound it derives from — a literal `48` in a second file is not a
smaller change, it is a worse one — but it is two files the brief did not name.

## The survey

The brief asked whether the same shape exists elsewhere in the file. Measured by
pushing a 100,000-character value into **every** string field and recording which
accept it, rather than by reading `.max()` calls off the page.

**Of 22 string fields, `field.target` was the only one that accepted it.**

Two results worth keeping:

- **`settings.accent` has no `.max()` and does not need one.** Its pattern is
  `^#[0-9a-fA-F]{6}$` — anchored, finitely bounded — so a 500,001-character value
  is refused in 0.160 ms. Unbounded in the schema, bounded by construction. This
  is the case that would have been reported as a second defect by a survey
  reading syntax instead of running it.
- **`publicSubmissionSchema.values` bounds each key and each value but not the
  number of keys.** 100,000 keys parse in 52 ms. A different shape of gap — an
  unbounded collection, not an unbounded string — so per the brief it is reported
  and **not** fixed.

## Testing

**15 new tests** in `packages/contracts/src/forms/schemas.test.ts`, asserted
through `formVersionConfigSchema` rather than through `fieldTarget`, because §6
asks what is **stored** and a bound proven only on the inner schema is a bound on
nothing.

`verify:all` exit 0: **1,103 passed / 223 skipped (1,326)**, against 1,088 / 223
(1,311) at the start. 29 boundary probes.

**8 observed red before the change**, by reverting only `schemas.ts` to
`4242da1` while keeping the constant and the tests, then restoring. The other 7 —
legitimate targets still accepted, malformed keys still refused — passed in
**both** states, which is what makes them controls.

Properties, not descriptions:

- The oversized value is **refused, not truncated**: `safeParse` fails, so no
  `data` exists and nothing reaches `form_versions.fields`.
- The cap admits exactly what a custom field key can hold and no more — a
  48-character key parses, a 49-character one does not.
- Parse cost on a 4 MB target is within 20× of a 4 KB one. Measured 672.6×
  before and 1.3× after, so the threshold has an order of magnitude of headroom
  either side rather than being a benchmark.

⚠️ That last one is the only test in the repository whose result depends on the
machine it runs on. It earns its place because it is the only assertion that
fails if someone restores `*` — every other test in the file passes with the
unbounded pattern, since the string is capped either way.

## Alternatives considered

**`.max()` alone.** The obvious fix, and it does stop the value being stored.
Rejected on the measurement above: it leaves the pattern's cost proportional to
input, and it reads as though the length is checked first, which is the belief
this session was told to verify rather than inherit.

**Bounded quantifier alone.** Sufficient in behaviour. Rejected on legibility —
the bound would live only inside an interpolated regex, and an oversized value
would produce a format complaint instead of `too_big`.

**A literal `55` or `48`.** Rejected: it decouples the target bound from the key
bound it exists to track.

**A CHECK constraint (§5).** Considered and rejected in ADR-0046: `fields` is
`jsonb` and the bound applies to a string nested inside one array element.

## Files

```
packages/contracts/src/crm/enums.ts                 CUSTOM_FIELD_KEY_MAX_LENGTH
packages/contracts/src/crm/lifecycle.ts             customFieldKey uses it
packages/contracts/src/forms/schemas.ts             the cap and the bounded quantifier
packages/contracts/src/forms/schemas.test.ts        15 tests
docs/decisions/ADR-0046-field-target-bound.md
docs/development-log/0027-the-field-target-cap.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Result

0018's oldest open finding is closed, and the survey it asked for returned a
clean negative: of 22 string fields reaching stored form config, exactly one was
unbounded.

**The useful part was not the cap.** It was that `.max()` does not gate
`.regex()` — a fact 0018 recorded in a different section, about a different
field, and which would have made the obvious one-line fix half a fix. The
measurement that mattered was not "does 0018 still reproduce" but "does the thing
0018 said about zod still hold", and the brief was right to ask for both.

## Remaining work

From 0018's list. Nothing remaining is on a live write path.

1. The CRM LIKE escaper misses `\`, which affects `countTracesOf` — the helper
   the integration suite uses to prove GDPR erasure, failing in the direction
   that looks green.
2. `verification.ts` inherits an 8 MB body cap where its comment says 1 MB.
3. The client-side email regex, as a length guard.

⚠️ Carried, and one new:

- **`publicSubmissionSchema.values` has no key-count cap** — 100,000 keys parse
  in 52 ms. Found by this survey, deliberately not fixed.
- **T12 does not name form-submitted context**, and that context is live now
  (0026).
- **`referrerHost` and `normaliseWebsiteHost` are byte-identical** in different
  packages (0026).
- `splitLandingUrl` is still dead (0025).
- The local development database is still at migration 0007, so the crawl schema
  has still only ever existed inside a test harness (0025).
