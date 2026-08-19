# 0028 — One LIKE escaper, and a near-miss correcting the entry that found it

**Date:** 2026-08-19 · **Stage:** 4

## Objective

Fix the CRM LIKE-pattern escaper so it also escapes the backslash, and confirm
`countTracesOf` — the GDPR-erasure verification helper — reports correctly after
the fix.

Dev log 0018's item 8, and the last of its findings that touches a helper the
test suite depends on.

## Initial state

Verified, not recalled: `cb5330e`, tree clean, `verify:all` exit 0 at **1103
passed / 223 skipped (1326)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Re-measured before acting (§0/§1)

**0018's line numbers hold exactly**, two sessions later:
`contacts/service.ts:321`, `companies/service.ts:105`, `erasure.ts:314`. All
three still carry the same expression, differing only in the callback parameter
name. A sweep for every `LIKE`/`ILIKE` construction confirms these are still the
only three.

### Measured against Postgres, not reasoned about

Fourteen cases of "this is stored, someone searches for that, should it be
found". **The inline form is wrong on 7 of 14; the fixed form on 0 of 14** —
wrong in both directions:

| stored         | searched for  | correct | inline        |
| -------------- | ------------- | ------- | ------------- |
| `Sara\Jones`   | `Sara\Jones`  | found   | **not found** |
| `SaraJones`    | `Sara\Jones`  | no      | **found**     |
| `a\`           | `a\`          | found   | **not found** |
| `C:\Users\sam` | `\Users\`     | found   | **not found** |
| `back\\slash`  | `back\\slash` | found   | **not found** |

The `%` and `_` cases are all handled correctly by both — the old escaper got the
half it attempted right.

### The injection framing holds

Re-verified as the brief required rather than carried forward: searching for
`x' or '1'='1` returns no match rather than breaking out of the literal. The
pattern is a bound parameter. A correctness defect, not a security one.

## ⚠️ The near-miss, which is the part worth keeping

0018 printed a three-row table with no search-term column. Reading it the obvious
way — each row searching for itself — makes its third row look wrong, and I had
the correction half-drafted:

> `Sara%` is handled correctly by both escapers, so 0018's third row does not
> reproduce.

**It reproduces exactly.** 0018's prose names the search term — `a\` for every
row — and I had read the table without it:

| subject       | inline  | fixed | 0018 said |
| ------------- | ------- | ----- | --------- |
| `Sara\Jones`  | no      | yes   | no / yes  |
| `Joanna\Bell` | no      | yes   | no / yes  |
| `Sara%`       | **yes** | no    | yes / no  |

Under the term `a\` the inline form builds `%a\%`, whose closing wildcard is
consumed as an escaped literal `%`, so it matches a stored `Sara%` — a trace
attributed to the wrong person.

Both readings were measured before either was written down, which is the only
reason the correction did not ship. §1 says a measurement decides and
source-level reasoning only proposes; here the thing being reasoned about was a
previous entry's table, and the same rule applied to it. **Two sessions running
have now found that the dev log's own records are as much a hypothesis as the
code is** — 0026 found a miscount carried through two entries, and this one
nearly introduced a false correction into a correct one.

## Why the third copy is worse than the other two

`countTracesOf` is not a search feature. It is how the integration suite proves
erasure — by searching for the old name rather than checking the columns the
erasure routine happens to touch, so that a test cannot pass by agreeing with the
implementation.

A search feature that under-reports shows an operator too few rows and they
search again. A verification helper that under-reports returns `0`, and the suite
records **"no trace remains"** for a person still in the database.

## The decision

One shared escaper in `packages/crm/src/shared/like.ts`, called by all three.
`shared/` already holds `context.ts` and `pagination.ts` with a test beside it,
so the location is the existing convention. `containsPattern` wraps the wildcards
as well as escaping, so no call site holds half the decision.

ADR-0047 has the argument. ⚠️ **The shared-helper half did not need an ADR** —
it is the fourth instance of the shape ADR-0044, ADR-0045 and ADR-0046 each
recorded. The ADR exists for the other half: `[\\%_]` looks like a typo and is
not, and no `ESCAPE` clause is emitted, which makes the patterns depend on
PostgreSQL's default escape character. Drizzle's `ilike()` cannot express one,
and emitting it only from `countTracesOf`'s raw SQL would give the verification
helper different escaping rules from the features it verifies.

## Testing

**17 new tests** — 10 unit in `shared/like.test.ts` asserting the pattern string,
7 integration in `lifecycle.integration.test.ts` asserting which rows PostgreSQL
matches. The split is deliberate: the unit tests assert the weak property and run
without a database; the strong property is only observable against a real server.

`verify:all` exit 0: **1,113 passed / 230 skipped (1,343)**, against 1,103 / 223
(1,326) at the start. 29 boundary probes. Against a throwaway migrated from zero,
the CRM lifecycle file runs **44 passed**.

**5 observed red before the change**, by reverting only the three call sites to
`cb5330e` while keeping the helper and the tests, then restoring.

### The differential the brief asked for

⚠️ **The 39 tests that passed in the reverted state are the differential.** They
include every pre-existing erasure assertion — `countTracesOf(owner, 'Nadia')`,
`'Haddad'`, `'nadia@example.test'`, `'0412 987 654'` — so **the fix changes
nothing for any existing fixture**, which is the result that makes it safe.

Two of the new tests are in that set deliberately: "still finds the plain terms
the erasure suite relies on" and "a percent or underscore is still a literal"
pass in **both** states. They are controls — without them, every backslash
assertion could pass while ordinary search regressed.

Properties, not descriptions:

- After escaping, the only unescaped `%` or `_` in a pattern are the two
  `containsPattern` added — asserted by walking the escaped body, over a corpus
  including `%%%` and `___`.
- Each source character is escaped exactly once: `String.replace` does not
  rescan its own output. Asserted rather than claimed, because it is the
  assumption under which a two-pass implementation would double-escape.

## Files

```
packages/crm/src/shared/like.ts                     escapeLike, containsPattern
packages/crm/src/shared/like.test.ts                10 tests
packages/crm/src/contacts/service.ts                listContacts delegates
packages/crm/src/companies/service.ts               listCompanies delegates
packages/crm/src/contacts/erasure.ts                countTracesOf delegates
packages/crm/src/lifecycle.integration.test.ts      7 tests
docs/decisions/ADR-0047-one-like-escaper.md
docs/development-log/0028-one-like-escaper.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Result

Three copies of one expression became one, and seven measured cases stopped
returning the wrong answer in both directions. The helper that proves GDPR
erasure can no longer return `0` for a person whose name contains a backslash.

**The finding itself was exactly as 0018 described it** — no correction, no
under- or over-statement, which after 0026 and 0027 both found the record wrong
is worth saying plainly. What nearly went wrong was my reading of it, and the
only thing that caught it was measuring both interpretations before writing
either down.

## Remaining work

From 0018's list. Nothing remaining is on a live write path.

1. `verification.ts` inherits an 8 MB body cap where its comment says 1 MB.
2. The client-side email regex, as a length guard.

⚠️ Carried, and one from this session's out-of-scope list:

- **`fieldKey` and `customFieldKey` have the unbounded-quantifier-behind-`.max()`
  shape** that ADR-0046 fixed on `fieldTarget` — real, not urgent, since the cost
  is linear rather than catastrophic. Its own brief.
- **`publicSubmissionSchema.values` has no key-count cap** — 100,000 keys parse
  in 52 ms (0027).
- **T12 does not name form-submitted context**, and that context is live now
  (0026).
- **`referrerHost` and `normaliseWebsiteHost` are byte-identical** in different
  packages (0026).
- `splitLandingUrl` is still dead (0025).
- The local development database is still at migration 0007, so the crawl schema
  has still only ever existed inside a test harness (0025).
