# ADR-0047 — One LIKE escaper, and the escape character is escaped first

**Status:** Accepted
**Date:** 2026-08-19

## Context

Dev log 0018 ranked this eighth of ten: three call sites build a substring
search pattern inline, and all three escape the two LIKE wildcards without
escaping the backslash that gives them their meaning.

### Re-measured at `cb5330e` before deciding anything

0018's line numbers hold exactly, two sessions later:

| site                                        | function        |
| ------------------------------------------- | --------------- |
| `packages/crm/src/contacts/service.ts:321`  | `listContacts`  |
| `packages/crm/src/companies/service.ts:105` | `listCompanies` |
| `packages/crm/src/contacts/erasure.ts:314`  | `countTracesOf` |

All three still carry the same expression, differing only in the callback
parameter name (`match` vs `m`). A search for every `LIKE`/`ILIKE` construction
in the repository confirms these remain the **only** three.

### Measured against the running Postgres, not reasoned about

§6 and 0018's own method. Fourteen cases of "this text is stored, someone
searches for that text, should it be found":

| stored         | searched for  | correct | inline form   | fixed |
| -------------- | ------------- | ------- | ------------- | ----- |
| `Sara\Jones`   | `Sara\Jones`  | found   | **not found** | found |
| `SaraJones`    | `Sara\Jones`  | no      | **found**     | no    |
| `a\`           | `a\`          | found   | **not found** | found |
| `C:\Users\sam` | `\Users\`     | found   | **not found** | found |
| `back\\slash`  | `back\\slash` | found   | **not found** | found |
| `Sara%`        | `Sara%`       | found   | found         | found |
| `SaraX`        | `Sara%`       | no      | no            | no    |
| `a_b`          | `a_b`         | found   | found         | found |

**The inline form is wrong on 7 of 14; the fixed form on 0 of 14.** Wrong in
both directions: it fails to find text that is there, and finds text that is
not.

### ⚠️ 0018's table reproduces exactly, once its search term is read correctly

0018 printed three rows without a search-term column, and the obvious reading —
that each row searches for itself — makes its third row look wrong. It is not.
Its prose states the term: **`a\` for every row.**

| subject       | inline  | fixed | 0018 recorded |
| ------------- | ------- | ----- | ------------- |
| `Sara\Jones`  | no      | yes   | no / yes ✓    |
| `Joanna\Bell` | no      | yes   | no / yes ✓    |
| `Sara%`       | **yes** | no    | yes / no ✓    |

Both readings were measured rather than one being assumed. Under the term `a\`,
the inline form builds `%a\%` — whose closing wildcard is consumed as an escaped
literal `%` — so it matches the stored value `Sara%` and stops being a substring
search. Recorded because the near-miss was mine: the correction I was about to
write into this ADR would have been the error.

### The framing holds: this is not injection

Re-verified as the brief required. The pattern is passed as a bound parameter,
never interpolated into SQL text. Searching for `x' or '1'='1` returns no match
rather than breaking out of the literal. A correctness defect, not a security
one — with one exception in severity, below.

### Why the third copy is worse than the other two

`countTracesOf` is not a search feature. It is the helper the integration suite
uses to prove GDPR erasure, by searching for the old name rather than by
checking the columns the erasure routine happens to touch. Its own docstring
says so.

A search feature that under-reports shows an operator too few results, and they
search again. A verification helper that under-reports returns `0`, and the suite
records **"no trace remains"** for a person still in the database. It fails in
the direction that looks green.

## Decision

**One shared escaper in `packages/crm/src/shared/like.ts`**, called by all three.

```ts
const LIKE_SPECIAL = /[\\%_]/g;
export function escapeLike(term: string): string;
export function containsPattern(term: string): string; // `%${escapeLike(term)}%`
```

`shared/` already holds `context.ts` and `pagination.ts` with a test beside it,
so the location is the established convention rather than a new one. It stays
inside `@growth-os/crm` because all three call sites are there; `contracts`
performs no I/O and this is a SQL concern, and promoting it to `@growth-os/database`
would be speculation about a second consumer that does not exist.

### Why `containsPattern` wraps the wildcards instead of leaving that to callers

All three sites did `%${escaped}%`. Exporting only an escape function would leave
each caller holding half a decision — and the failure mode of that half is
silent: escaping correctly and forgetting the `%` yields an exact-match search
that simply returns fewer rows. Both halves live in one place. `escapeLike` is
exported as well for a future anchored match, and is what `containsPattern` is
built from.

### ⚠️ Why this needed an ADR when "three copies become one" no longer does

The shared-helper half is, by now, close to obvious: ADR-0044, ADR-0045 and
ADR-0046 each recorded the same shape, and this is the fourth. That half would
not have been worth a document.

**The escape character would.** Two things a future reader cannot re-derive from
the code:

1. **`[\\%_]` looks like a typo and is not.** A backslash inside a character
   class beside two wildcards reads as an escaping artefact, and removing it
   restores the defect while leaving every test name intact. The order within
   the class is also load-bearing to nobody — `String.replace` does not rescan
   its own output, so each source character is escaped exactly once — and that
   is asserted rather than left as a claim, because it is the assumption under
   which a two-pass implementation would double-escape.
2. **No `ESCAPE` clause is emitted, and that is a dependency, not an oversight.**
   The patterns rely on PostgreSQL's default LIKE escape character being `\`.
   Drizzle's `ilike()` helper cannot express an `ESCAPE` clause, and the raw
   `sql` template in `countTracesOf` could but would then differ from the other
   two. All measurements here were taken against that default. A server
   configured otherwise, or a move off Drizzle, silently changes what these
   patterns mean.

## Alternatives considered

**Fix the three sites identically, in place.** The minimal change, and it makes
every measurement above pass. Rejected: three copies of a corrected expression is
the same structure that produced the defect, and the next divergence would be as
invisible as this one was. The specific risk is not hypothetical — one of the
three is a verification helper, so a partial fix would leave the suite proving
erasure with a weaker escaper than the feature it verifies.

**Put the helper in `@growth-os/contracts`.** Rejected on direction: contracts is
the vocabulary layer and performs no I/O. A LIKE pattern is a database concern.

**Put it in `@growth-os/database`.** Defensible, and where it should move if a
second package ever builds a LIKE pattern. Rejected today as speculation — all
three call sites are in `crm`, and the boundary probe suite would need a new rule
for an edge nothing traverses.

**Emit an explicit `ESCAPE '\'` clause.** The robust answer to point 2 above, and
rejected because Drizzle's `ilike()` cannot express it. Emitting it only from
`countTracesOf`'s raw SQL would make the verification helper and the features it
verifies use different escaping rules, which is precisely the divergence this ADR
removes. Recorded as a known dependency instead.

**Strip backslashes from search terms rather than escaping them.** Rejected: it
makes `Sara\Jones` and `SaraJones` the same query, which is the false positive
already measured, chosen deliberately instead of by accident.

## Consequences

### Positive

- One definition of "turn what someone typed into a substring pattern", with the
  wildcards and the escaping decided in the same place.
- Seven measured cases stop returning the wrong answer, in both directions.
- `countTracesOf` can no longer report `0` for a person whose stored name
  contains a backslash.

### Negative

- **The `ESCAPE` dependency is documented, not enforced.** Nothing fails if a
  server's escape character differs; the patterns just quietly mean something
  else. There is no test for it because there is no supported way to configure it
  per-connection in this stack.
- **`escapeLike` is exported with no caller.** `containsPattern` is built from it
  and it is the honest decomposition, but it is currently dead in the sense
  ADR-0044 used the word about `splitLandingUrl`.
- The helper is `crm`-local. A second package needing LIKE patterns will have to
  move it, and moving it is the moment the `database` question above gets
  answered properly.

## Verification

**10 unit tests** in `packages/crm/src/shared/like.test.ts` asserting the pattern
string, and **7 integration tests** in `packages/crm/src/lifecycle.integration.test.ts`
asserting which rows PostgreSQL actually matches. The split is deliberate: the
unit tests assert the weak property and run without a database; the strong
property is only observable against a real server, which is what 0018 measured
and what §6 requires.

**5 were observed red before the change**, by reverting only the three call sites
to `cb5330e` while keeping the helper and the tests, then restoring.

⚠️ **The 39 that passed in that reverted state are the differential the brief
asked for.** They include every pre-existing erasure assertion —
`countTracesOf(owner, 'Nadia')`, `'Haddad'`, `'nadia@example.test'`,
`'0412 987 654'` — so the fix changes nothing for any existing fixture. Two of
the new tests are also in that set by design: "still finds the plain terms the
erasure suite relies on" and "a percent or underscore is still a literal" pass in
**both** states, which is what makes them controls rather than filler.

Full suite `verify:all` exit 0 at **1,113 passed / 230 skipped (1,343)**, against
1,103 / 223 (1,326) at `cb5330e`. With `TEST_DATABASE_URL` set against a
throwaway migrated from zero, the CRM lifecycle file runs **44 passed**.
