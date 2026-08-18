# ADR-0041 — A query value is octets, not text, and normalising it must not decode

**Status:** Accepted
**Date:** 2026-08-18

## Context

AGENTS.md §5 says URL identity is singular. It was singular and wrong.

`normaliseQuery` took a `URLSearchParams` and rebuilt it. Iterating one **decodes
each value into a JavaScript string**, and a byte that is not valid UTF-8 has no
character to decode to — it becomes U+FFFD, which re-encodes as `%EF%BF%BD`. The
original byte is gone and cannot be recovered.

### Where the loss actually happens

The brief asked for this to be measured rather than assumed, because dev log
0018's negative results had already cleared the three percent-encoding patterns
sitting next to the defect. Walking the pipeline stage by stage on
`?q=Fran%E7ois`:

| stage                   | value                                |
| ----------------------- | ------------------------------------ |
| `new URL().search`      | `?q=Fran%E7ois` — **bytes intact**   |
| `[...url.searchParams]` | `[["q","Fran�ois"]]` — **lost here** |
| `rebuilt.toString()`    | `q=Fran%EF%BF%BDois`                 |

The loss is at the **iteration**, not at `toString()`, not at the `/\+/g`
replacement, and not in `normalisePercentEncoding`. 0018 was right that those
three are sound by construction; the defect was beside them.

### How bad it is

Measured through the module:

| corpus                                   | inputs | identities before | after |
| ---------------------------------------- | -----: | ----------------: | ----: |
| `?q=%XX` for every byte 0x00–0xFF        |    256 |           **129** |   256 |
| every high byte in three query positions |    384 |             **3** |   384 |

**All 128 bytes from 0x80 to 0xFF shared one identity.** The generated corpus
collided at **99.2 %**.

### ⚠️ And the two halves of one URL disagreed

```
/produits/caf%E9      →  /produits/caf%E9          (path: byte preserved)
/produits?nom=caf%E9  →  /produits?nom=%EF%BF%BD   (query: byte destroyed)
```

`url.pathname` is not decoded, so the path was already correct. One URL,
normalised under two incompatible rules — which is the clearest statement of the
defect and the reason it is an identity bug rather than an encoding preference.

### Why it is not cosmetic

`frontier.ts` stores only the normalised form and discards the original, so the
crawler **fetches a URL the site never linked**. That string keys the durable
`site_pages(site_id, normalised_url)` index, which is architectural horizon #1 —
wrong identity is permanent across crawls, and a later fix is a migration and a
backfill of rows nobody can map back.

## Decision

**`normaliseQuery` takes `url.search` — the raw string — and treats the query as
octets.**

Split on `&`, then on the first `=`. Neither needs decoding. Each component gets
`+` → `%20` (the one substitution a query genuinely requires) and then
`normalisePercentEncoding`, which uppercases hex digits and decodes **only** the
RFC 3986 unreserved set.

### ⚠️ Why decoding the unreserved set is safe on a query

That set is `ALPHA / DIGIT / "-" / "." / "_" / "~"` and **contains no
delimiter**. Decoding it can never manufacture a `&`, `=`, `?`, `#` or `/`, so
one parameter can never silently become two. Dev log 0018 established this
property while clearing the same function for the path; it is what makes the
function reusable here rather than needing a second, divergent one.

A `%` not followed by two hex digits is not an escape and is not touched.

### What this fixes beyond the reported defect

`?q=%ZZ` was decoded to the literal `%ZZ` and re-encoded to `%25ZZ` — **the
identity of `?q=%25ZZ`, a genuinely different URL**. Same for a bare `%` and
`%25`. Two more collisions, found by measurement rather than by the report.

### ⚠️ The strip list stays case-INSENSITIVE, and PHPSESSID is the reason

The brief asked for this to be decided deliberately, noting that parameter names
are case-sensitive to most servers so `?REF=1` and `?SID=abc` are currently
discarded.

Measured, the trade is not symmetric:

| parameter          | stripped today | under case-sensitive matching |
| ------------------ | -------------- | ----------------------------- |
| `PHPSESSID=abc`    | yes            | **no**                        |
| `JSESSIONID=abc`   | yes            | **no**                        |
| `CFID=1&CFTOKEN=2` | yes            | **no**                        |
| `UTM_SOURCE=g`     | yes            | **no**                        |

`PHPSESSID` is PHP's literal default name for a cookieless session, uppercase,
and `JSESSIONID`, `CFID` and `CFTOKEN` are the same. **Case-insensitive matching
is the only reason those are stripped at all**, and an unstripped session id is a
new identity per visitor — unbounded, one template consuming a whole crawl
budget. That is strictly worse than the false strip it would prevent.

And it would not fix the concern that motivated the question: the lowercase
spellings `?ref=` and `?sid=` are the common ones and would still be stripped.
**Case-sensitivity buys almost nothing for that risk and costs `PHPSESSID`.** The
risk is a property of the _list contents_, not of case matching, and changing the
list is a separate identity change with its own differential.

⚠️ **A related finding, reported and not fixed:** `aspsessionid` is dead as
written. Classic ASP emits `ASPSESSIONID` followed by eight random letters, so
the exact-match entry never fires — measured,
`?ASPSESSIONIDQWERTY=abc` is **not** stripped. Making it work needs prefix
matching, which is a change to what the list _means_, not to this defect.

## The differential

⚠️ Required by the brief, because this changes URL identity and §5 makes
identity singular. Shipped module against `32e35f2`, over a 1,037-URL corpus —
every byte in three query positions, every byte in a path, and 13 ordinary URLs:

|                     |  before |     after |
| ------------------- | ------: | --------: |
| distinct identities | **654** | **1,035** |
| inputs changed      |       — |   **390** |
| inputs unchanged    |       — |       647 |

**Every one of the 390 changes is in a query.** All 256 path inputs are
byte-identical, and **0 of the 13 ordinary URLs changed** — the shapes a real
site actually serves are untouched.

### No two genuinely-different URLs collapse afterwards

| collision classes (one identity, several URLs) |                                               count |
| ---------------------------------------------- | --------------------------------------------------: |
| before                                         | **5** — the three largest holding **128 URLs each** |
| after                                          |                                               **2** |

Both survivors are deliberate, documented equivalences, not defects:

1. `?q=red+shoes` ≡ `?q=red%20shoes` — `+` is a space in a query. Pre-existing
   and intentional; consistency is what stops a duplicate row.
2. `?utm_source=g&id=1` ≡ `?PHPSESSID=x&id=1` — both strip to `?id=1`, which is
   the strip list doing exactly its job.

**Zero unintended collisions remain.**

## Alternatives considered

**Keep `URLSearchParams` and re-encode from a `Uint8Array`.** There is nothing to
re-encode from: the bytes are already gone by the time the iterator yields, and
U+FFFD is not reversible.

**Decode to `latin1` instead of UTF-8.** Rejected. It swaps one guess for
another — it would mangle genuine UTF-8 rather than genuine Latin-1 — and the
correct answer is to guess nothing. The crawler does not know the site's query
charset and does not need to: identity is the bytes.

**Percent-encode everything, decoding nothing.** Rejected: `%41` and `A` are the
same character by RFC 3986 §6.2.2.2, and `%2f` and `%2F` the same byte by
§6.2.2.1. Not canonicalising them reintroduces the duplicate-spelling problem
this module exists to solve, in the other direction.

**Escape a bare `%` to `%25` to keep the output strictly RFC-valid.** Rejected on
measurement: it is what collided `?q=%` with `?q=%25`, and the identity is a
fixed point without it — `new URL(id).href === id` for all 14 hostile cases
tested, so the fetcher asks for exactly the string that was stored.

**Make the strip list case-sensitive.** Rejected above, with the measurement.

## Consequences

### Positive

- Five URLs no longer share two identities; 384 no longer share three. The
  durable `site_pages` key is the bytes the site served.
- The crawler stops fetching URLs nobody linked — the direct consequence of
  `frontier.ts` storing only the normalised form.
- Path and query are finally normalised under the same rule, by the same
  function.
- Two collisions nobody reported (`%ZZ`/`%25ZZ`, `%`/`%25`) are gone.

### Negative

- **390 of 1,037 corpus URLs change identity.** Any rows already written under
  the old normalisation keep the old key. Nothing in the repository writes
  production crawl rows yet, so there is no backfill today — but this is the last
  moment that is true, and it is why the brief ranked this above everything else
  in dev log 0018.
- A query value now round-trips bytes the previous implementation would have
  replaced, so a stored identity can contain sequences that are not valid UTF-8.
  They are valid percent-encoding and parse cleanly; the fixed-point test pins
  this.
- `aspsessionid` remains dead as written.

## Verification

**23 new tests** in `packages/crawler/src/urls/normalise.test.ts`. Suite:
**948 passed / 208 skipped (1156)**, against 925 / 208 before. 29 boundary
probes.

**17 were observed red before the fix** and green after, including the
five-URLs-to-two-identities case from dev log 0018.

Properties asserted rather than described:

- 256 single-byte query values produce **256** identities (129 before).
- Over a 384-URL non-UTF-8 corpus, **no two inputs share an identity** — asserted
  as an empty collision list, not a count.
- The identity is a **fixed point**: for 14 hostile inputs,
  `normaliseUrl(normaliseUrl(x)) === normaliseUrl(x)` **and**
  `new URL(id).href === id`, so what is stored is what the fetcher requests.
- Decoding can never manufacture a delimiter — `%26`, `%3D`, `%23`, `%3F` stay
  escaped.

Hostile input per §6: lone surrogates, overlong UTF-8 (`%C0%80`), truncated
escapes (`%ZZ`, `%A`, a bare `%`), mixed valid and invalid bytes in one value, a
value that is entirely escapes, a NUL byte, and both halves of a surrogate pair
split across two parameters.

**No existing test changed.** The suite that already covered stripping, sorting,
repeat order, space spelling and idempotence passed untouched, which is the
evidence that the change is confined to bytes the old code destroyed.

## Related

- [ADR-0033](ADR-0033-url-normalisation.md) — the one definition of crawl identity
- [ADR-0034](ADR-0034-crawl-storage-model.md) — `site_pages`, which this string keys
- [ADR-0038](ADR-0038-url-length-ceiling.md) — the other change to this function
- [dev log 0018](../development-log/0018-the-regex-sweep.md) — finding 4, where this was measured
- [dev log 0022](../development-log/0022-the-query-identity-collision.md) — this work
