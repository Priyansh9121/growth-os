# ADR-0046 — A field target is bounded by the key it must name, and its pattern is bounded too

**Status:** Accepted
**Date:** 2026-08-19

## Context

Dev log 0018 ranked this tenth of ten and described it in one line: `fieldTarget`
in `packages/contracts/src/forms/schemas.ts` has no `.max()` at all, and a
200,007-character `custom:aaa…` value parses successfully into stored form
config. It stayed open through 0025 and 0026 because nothing on a live write
path depended on it.

### Re-measured at `4242da1` before deciding anything

The finding reproduces exactly, and is slightly worse than recorded — the value
is not merely accepted, it is **stored at full length**:

| input                     | result                          |
| ------------------------- | ------------------------------- |
| `custom:` + 1,000 `a`     | PARSED, stored length 1,007     |
| `custom:` + 200,000 `a`   | PARSED, stored length 200,007   |
| `custom:` + 1,000,000 `a` | PARSED, stored length 1,000,007 |

There is no bound of any kind, so 200,007 was never a ceiling — it was the size
0018 happened to try.

### What it is not

Measured rather than assumed, because the obvious reading is that an unbounded
pattern over hostile input is a timing defect:

- **The pattern is linear, not backtracking.** `^custom:[a-z][a-z0-9_]*$` costs
  2.33 ms against 4 MB — proportional to input, with no exponential case.
- **`mapped.customFields` is never consumed.** `submit.ts:374` slices the key
  off the target and writes it into a `customFields` record, and nothing reads
  that record. Traced, not inferred: `mapped.identity`, `mapped.note` and
  `mapped.missingRequired` are all used; `mapped.customFields` is not.
- **`target` is absent from `PublicFormFieldView`**, so the value is never
  published to a browser.
- **Writing form config requires an authenticated operator.** This is not an
  anonymous path.

So the blast radius is one thing: unbounded strings in the `form_versions.fields`
`jsonb` column, in a table whose rows are immutable version snapshots and are
therefore kept forever. A data-integrity defect, which is how 0018 ranked it.

### ⚠️ §5's "limits live in the database" does not reach this one

The invariant names budget ceilings, page caps and rate limits — scalar columns
where a CHECK constraint is the natural home and application validation is the
weaker copy. `fields` is `jsonb`, and the bound applies to a string nested inside
one element of an array inside it. A CHECK constraint expressing that would be
less legible than the schema and would duplicate it. The bound stays in the
schema, and this paragraph exists so the next reader knows the invariant was
considered rather than overlooked.

## Decision

Two parts, and the second is the one worth recording.

### 1. The cap is derived, not chosen

```ts
const MAX_FIELD_TARGET_LENGTH =
  CUSTOM_FIELD_TARGET_PREFIX.length + CUSTOM_FIELD_KEY_MAX_LENGTH;
```

A `custom:<key>` target exists to name a CRM custom field, so the longest target
that can ever be useful is the prefix plus the longest key the CRM accepts —
`7 + 48 = 55`. Any smaller cap makes some legitimate key unmappable; any larger
one admits targets that cannot correspond to a field.

`CUSTOM_FIELD_KEY_MAX_LENGTH` is a new export from `contracts/src/crm/enums.ts`.
It was a bare `48` inside `customFieldKey` in `contracts/src/crm/lifecycle.ts`,
and writing a second `48` in the forms schema would have created exactly the
condition ADR-0044 and ADR-0045 were both written about: two literals for one
bound, drifting silently. The CRM package owns the concept, so the constant lives
there and the forms schema derives from it.

### 2. ⚠️ The quantifier is bounded, because `.max()` does not bound the pattern

```ts
z.string()
  .max(MAX_FIELD_TARGET_LENGTH)
  .regex(
    new RegExp(
      `^${CUSTOM_FIELD_TARGET_PREFIX}[a-z][a-z0-9_]{0,${CUSTOM_FIELD_KEY_MAX_LENGTH - 1}}$`,
    ),
  );
```

Dev log 0018 found separately that **zod v4 runs every check and collects all
issues**, so `.max()` bounds what is _accepted_ and never what is _examined_.
Re-measured on zod 4.4.3: a 200,007-character target produces **both**
`too_big` and `invalid_format`, which is direct evidence the pattern still ran
at full length after the length check had already failed.

So `.max()` alone would have left the pattern's cost proportional to attacker
input. Bounding the quantifier removes that, and not by a constant factor:

| target size | `[a-z0-9_]*` | `[a-z0-9_]{0,47}` |
| ----------- | -----------: | ----------------: |
| 1 KB        |   0.00064 ms |       0.000145 ms |
| 100 KB      |    0.0579 ms |       0.000128 ms |
| 1 MB        |     0.579 ms |       0.000129 ms |
| 4 MB        |     2.331 ms |       0.000130 ms |

Anchored at both ends with every quantifier finitely bounded, the engine tries
one start offset, consumes at most 55 characters and gives up. The cost is
**independent of input length**, not merely small — the class dev log 0018 named
when it measured `http.ts:46` flat at 10 MB.

End to end through `formVersionConfigSchema`, for the same 1000× increase in
input: **672.6× before, 1.3× after.**

`.max()` is kept as well. It states the bound where a reader looks for it, and
it produces `too_big` rather than a pattern-mismatch message for an
oversized-but-well-formed value.

## ⚠️ Why this needed an ADR when a `.max()` would not have

The brief anticipated that a straightforward `.max()` would not be worth
recording, and that is right. This is not that:

- The bounded quantifier looks redundant beside `.max()` and is not. A future
  reader tidying the pattern back to `*` would restore the defect while leaving
  every test name and the cap intact — and would be reasoning correctly from the
  usual assumption that a length check runs first.
- The constant crosses a package boundary that did not previously carry it.

Both are decisions someone would otherwise have to re-derive from a measurement
they have no reason to take.

## Alternatives considered

**`.max()` alone, keeping `*`.** The obvious fix, and it does stop the value
being stored. Rejected because it leaves the pattern's cost proportional to input
that an operator controls — measured at 2.33 ms per 4 MB — and because it reads
as though the length is bounded before the pattern runs, which is the belief that
made this worth measuring in the first place.

**Bounded quantifier alone, no `.max()`.** Sufficient in behaviour: the anchored
pattern already refuses anything longer. Rejected on legibility — the bound would
exist only inside a regex built by string interpolation, where nobody looks for
it, and the error message for an oversized value would be a format complaint.

**A literal `55`, or a literal `48`.** Rejected: it decouples the target bound
from the key bound it exists to track. If `CUSTOM_FIELD_KEY_MAX_LENGTH` is ever
raised, a literal silently makes the newest keys unmappable from a form.

**A CHECK constraint on `form_versions.fields`.** Considered because of §5, and
rejected above — the value is nested inside `jsonb`.

**Also capping `publicSubmissionSchema.values` key count.** Found during the
survey below and deliberately not fixed here; it is a different shape of gap
(an unbounded collection, not an unbounded string) and belongs in its own brief.

## The survey

The brief asked whether the same gap exists on any other string field reaching
stored config. Measured by pushing a 100,000-character value into every string
field in the file and recording which ones accept it, rather than by reading
`.max()` calls off the page.

**Of 22 string fields, `field.target` was the only one that accepted it.** The
other 21 refuse — `field.key`, `label`, `placeholder`, `helpText`, `options[]`,
`submitLabel`, `allowedOrigins[]`, `success.message`, `success.url`,
`opportunity.titleTemplate`, every `submissionContext` field, `submissionId`,
`trap`, `challengeToken`, `values` keys and values, and the four admin-API
fields.

Two results worth keeping:

- **`settings.accent` has no `.max()` and does not need one.** Its pattern is
  `^#[0-9a-fA-F]{6}$` — anchored, finitely bounded, so a 500,001-character value
  is refused in 0.160 ms and cannot be stored. Unbounded in the schema, bounded
  by construction. This is the negative result that shows the survey was looking
  at behaviour rather than at syntax.
- **`publicSubmissionSchema.values` bounds each key and value but not the number
  of keys.** 100,000 keys parse in 52 ms. Out of scope here and reported rather
  than fixed; noted in dev log 0027's remaining work.

## Consequences

### Positive

- An operator can no longer write an unbounded string into an immutable version
  snapshot.
- The pattern's cost stops depending on operator-supplied input.
- One definition of how long a custom field key may be, shared by the schema that
  creates keys and the schema that references them.

### Negative

- **A forms schema now imports from `crm/enums`.** The edge already existed
  (`classify-source.ts` imports `../crm/enums`), so this makes an existing
  direction load-bearing rather than creating one.
- **The bound is in application validation, not the database.** Argued above, and
  it means a row written directly by SQL bypasses it.
- **A timing assertion lives in the unit suite.** Measured 672.6× versus 1.3× and
  the threshold is 20×, so it is a shape assertion with an order of magnitude of
  headroom either side rather than a benchmark — but it is still the only test in
  the file whose result depends on the machine.

## Verification

**15 new tests** in `packages/contracts/src/forms/schemas.test.ts`, asserted
through `formVersionConfigSchema` — the gate on stored config — rather than
through `fieldTarget`, so the bound is proven where it takes effect.

**8 were observed red before the change**, by reverting only
`packages/contracts/src/forms/schemas.ts` to `4242da1` while keeping the new
constant and the tests, then restoring. The remaining 7 — legitimate targets
still accepted, malformed keys still refused — passed in **both** states, which
is what makes them controls rather than filler.

Full suite **1,103 passed / 223 skipped (1,326)**, against 1,088 / 223 (1,311) at
`4242da1`. 29 boundary probes.
