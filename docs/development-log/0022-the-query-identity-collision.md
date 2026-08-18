# 0022 — The query identity collision, and the last §5 violation

**Date:** 2026-08-18 · **Stage:** 4

## Objective

Fix the URL identity collision in `normaliseQuery`, test-first. Dev log 0018
finding 4 — the highest-ranked open item and the only remaining §5 invariant
violation.

## Initial state

Verified, not recalled: `32e35f2`, tree clean, `verify:all` exit 0 at **925
passed / 208 skipped (1133)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Investigation

### Where the bytes are lost, measured rather than assumed

The brief asked for this specifically, because 0018's negative results had
already cleared the three percent-encoding patterns sitting next to the defect.
Walking the pipeline on `?q=Fran%E7ois`:

| stage                   | value                                |
| ----------------------- | ------------------------------------ |
| `new URL().search`      | `?q=Fran%E7ois` — **bytes intact**   |
| `[...url.searchParams]` | `[["q","Fran�ois"]]` — **lost here** |
| `rebuilt.toString()`    | `q=Fran%EF%BF%BDois`                 |

The loss is at the **iteration**, not at `toString()`, not at the `/\+/g`
replacement, not in `normalisePercentEncoding`. 0018 was right about all three;
the defect was beside them, in the line nobody suspected because it does not look
like string handling at all.

### How large the collision is

| corpus                                   | inputs | identities before | after |
| ---------------------------------------- | -----: | ----------------: | ----: |
| `?q=%XX` for every byte 0x00–0xFF        |    256 |           **129** |   256 |
| every high byte in three query positions |    384 |             **3** |   384 |

**All 128 bytes from 0x80 to 0xFF shared a single identity.** The generated
corpus collided at **99.2 %**. The reported case — five URLs, two identities —
was the small end of it.

### The asymmetry, confirmed

```
/produits/caf%E9      →  /produits/caf%E9          (path: preserved)
/produits?nom=caf%E9  →  /produits?nom=%EF%BF%BD   (query: destroyed)
```

`url.pathname` is never decoded, so the path half was always right. One URL,
two halves, incompatible rules.

### Two collisions nobody reported

Found by measuring rather than by reading the finding: `?q=%ZZ` was decoded to
the literal `%ZZ` and re-encoded to `%25ZZ` — **the identity of `?q=%25ZZ`**. The
same for a bare `%` and `%25`. A malformed escape and a correctly-escaped percent
were the same page.

### ⚠️ The fixed-point check that decided one design question

The identity is stored and later re-parsed by `admitUrl` and the fetcher, so if
`new URL()` rewrote it, the row stored would not be the URL requested — a new way
of fetching something nobody linked, inside the fix for fetching something nobody
linked.

Measured over 14 hostile identities including `?q=%`, `?q=%ZZ`, `?q=~` and
`?a=1;b=2`: **25/25 stable**, identical to the current implementation's score.
That is what made it safe to preserve a bare `%` verbatim instead of escaping it
to `%25` — and escaping it is exactly what had collided it.

## What was decided

**`normaliseQuery` takes `url.search`, the raw string, and treats the query as
octets.** Split on `&`, then the first `=`; neither needs decoding. Each
component gets `+` → `%20` and then `normalisePercentEncoding`.

⚠️ **The property that makes reusing that function safe on a query**: it decodes
only the RFC 3986 unreserved set, and that set contains **no delimiter**, so
decoding can never manufacture a `&` or an `=` and split one parameter into two.
0018 established this while clearing the same function for the path.

**The strip list stays case-insensitive**, and the measurement decided it:

| parameter          | stripped today | if matched case-sensitively |
| ------------------ | -------------- | --------------------------- |
| `PHPSESSID=abc`    | yes            | **no**                      |
| `JSESSIONID=abc`   | yes            | **no**                      |
| `CFID=1&CFTOKEN=2` | yes            | **no**                      |

`PHPSESSID` is PHP's literal default, uppercase. Case-insensitive matching is the
only reason it is stripped at all, and an unstripped session id is a new identity
per visitor — unbounded, strictly worse than the false strip it would prevent.
And it would not address the concern that prompted the question: `?ref=` and
`?sid=` lowercase are the common spellings and would still be stripped. The risk
is in the list's _contents_, not in case matching.

⚠️ **Reported, not fixed:** `aspsessionid` is dead as written. Classic ASP emits
`ASPSESSIONID` plus eight random letters, so the exact-match entry never fires —
measured, `?ASPSESSIONIDQWERTY=abc` is **not** stripped. Fixing it needs prefix
matching, which changes what the list means.

## Result

Differential over 1,037 URLs — every byte in three query positions, every byte in
a path, and 13 ordinary URLs — shipped module against `32e35f2`:

|                     |  before |     after |
| ------------------- | ------: | --------: |
| distinct identities | **654** | **1,035** |
| inputs changed      |       — |   **390** |
| inputs unchanged    |       — |       647 |

**Every one of the 390 changes is in a query.** All 256 path inputs are
byte-identical and **0 of the 13 ordinary URLs changed** — the shapes a real site
serves are untouched.

Collision classes — one identity holding several URLs:

|        | classes | largest                         |
| ------ | ------: | ------------------------------- |
| before |   **5** | **128 URLs** share one identity |
| after  |   **2** | 2 URLs                          |

Both survivors are deliberate and documented: `?q=red+shoes` ≡ `?q=red%20shoes`
(`+` is a space), and two URLs whose only difference is a stripped tracking or
session parameter. **Zero unintended collisions remain.**

## Testing

**23 new tests** in `packages/crawler/src/urls/normalise.test.ts`. `verify:all`
exit 0: **948 passed / 208 skipped (1156)**, against 925 / 208 (1133) at the
start. 29 boundary probes.

**17 were observed red before the fix** and green after, including the
five-URLs-to-two-identities case.

Properties asserted as properties: 256 single-byte values give 256 identities;
over a 384-URL non-UTF-8 corpus the collision list is asserted **empty**, not
counted; the identity is a fixed point that `new URL().href` agrees with; and
decoding can never manufacture a delimiter.

Hostile input per §6: lone surrogates, overlong UTF-8, truncated escapes (`%ZZ`,
`%A`, bare `%`), mixed valid and invalid bytes, an all-escapes value, a NUL byte,
and both halves of a surrogate pair split across two parameters.

⚠️ **No existing test changed** — worth stating, because the previous three
briefs each moved an assertion. The suite already covering stripping, sorting,
repeat order, space spelling and idempotence passed untouched, which is the
evidence that this change is confined to bytes the old code destroyed.

All differential probes were throwaway, ran against a frozen copy of the module
at `32e35f2`, and were deleted before commit. Committed fixtures are synthetic
and reach no network.

## Files

```
packages/crawler/src/urls/normalise.ts        normaliseQuery takes url.search; normaliseQueryOctets
packages/crawler/src/urls/normalise.test.ts   23 tests
docs/decisions/ADR-0041-query-identity-preserves-bytes.md
docs/development-log/0022-the-query-identity-collision.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Remaining work

Dev log 0018's ranked list. Items 1–4 are now closed; **this was the last §5
invariant violation on the list.** What remains is a migration and five smaller
items, none of which is an identity or permission defect:

1. **The `crawl_frontier` CHECK, `url_too_long` and `budget_exhausted`** — one
   migration, three things waiting on it. The largest remaining item and the only
   one needing a from-zero database probe (§7.2).
2. `neutraliseCsvFormula` is documented as a live control and has no callers —
   fix the doc now, or wire it when an export exists.
3. `fieldTarget` has no `.max()` and accepts a 200 KB value into stored config.
4. Four `/^https?:\/\//i` copies disagree — one normaliser, or four documented
   behaviours.
5. The CRM LIKE escaper misses `\`, which affects `countTracesOf` — the helper
   the integration suite uses to prove GDPR erasure.
6. `verification.ts` inherits an 8 MB body cap where its comment says 1 MB.
7. The client-side email regex, as a length guard.
