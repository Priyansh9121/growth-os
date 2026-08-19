# ADR-0043 — One session parameter is matched by prefix, and only one

**Status:** Accepted
**Date:** 2026-08-19

## Context

`normaliseUrl` strips session-shaped query parameters for identity, because a
session id in a URL creates a new URL for every visitor: a crawler that kept them
would treat one page as infinitely many and exhaust its budget on a single
template.

The list matched **exact names only**. One entry could therefore never fire.

### Measured

IIS emits a Classic ASP session id as `ASPSESSIONID` followed by **eight letters
that differ per application pool**. The bare name `aspsessionid` is not something
IIS ever sends. Re-measured this session through the module:

| parameter                  | before   |
| -------------------------- | -------- |
| `aspsessionid=abc`         | stripped |
| `ASPSESSIONID=abc`         | stripped |
| `ASPSESSIONIDQWERTY=abc`   | **kept** |
| `ASPSESSIONIDACSSDACR=abc` | **kept** |
| `ASPSESSIONIDSQBSTBRA=abc` | **kept** |
| `PHPSESSID=abc`            | stripped |
| `JSESSIONID=abc`           | stripped |

So the entry stripped exactly the two spellings no server produces, and none of
the ones every Classic ASP server produces. It was decoration.

The cost is not cosmetic. A kept session id is a **new crawl identity per
visitor** — unbounded rows for one template — which is the precise failure the
session list exists to prevent, and it lands on `site_pages(site_id,
normalised_url)`, which is durable across crawls (architectural horizon #1).

## Decision

**`aspsessionid` moves out of the exact-match list into a prefix list of exactly
one entry.**

```ts
const SESSION_PARAMETER_PREFIXES: readonly string[] = ['aspsessionid'];
```

Every other name stays an exact match.

### ⚠️ Why the prefix list is deliberately one entry, and must stay that way

Prefix matching is a wider net, and a wider net **collapses distinct URLs into
one identity** — which §5 exists to prevent and ADR-0041 spent a whole brief
undoing. The danger is concrete: `sid` is in the session list, and as a prefix it
would strip `sidebar`, `side` and `sid_type`; `ref` would strip `refresh`.

`aspsessionid` earns the exception on two grounds. It is **twelve characters**,
which is long enough to be effectively unique, and the value it guards is
unbounded identity growth rather than a tidier URL. Neither is true of the short,
generic entries.

## The differential

⚠️ Required because this changes URL identity, the same way ADR-0041 required
it. Measured over **80 realistic parameter names** — real query parameters a site
serves, the whole existing strip list, deliberate near-misses, and the IIS
shapes:

|                    |  count |
| ------------------ | -----: |
| unchanged          | **75** |
| newly **stripped** |  **5** |
| newly **kept**     |  **0** |

All five newly stripped are IIS session ids: `ASPSESSIONIDQWERTY`,
`ASPSESSIONIDACSSDACR`, `ASPSESSIONIDSQBSTBRA`, `ASPSESSIONIDCCTBQBTA`,
`aspsessionidqwerty`.

**All 73 names that do not start with the prefix are unchanged**, so the change
is exactly as wide as the prefix and no wider. The near-misses that must not be
caught — `asp`, `aspect`, `aspnet`, `aspx`, `asp_net`, `aspect_ratio` — are all
still kept, before and after.

No URL that was previously kept under a _different_ name is now stripped, and
nothing that was stripped is now kept.

## Alternatives considered

**Correct the comment and leave the behaviour.** This is what dev log 0022
recorded as the deferred option, and it is what the brief for this work offered.
Rejected on the measurement: unlike the other two claims in this brief, there
**is** something wired here. The strip list is live, one of its entries does
nothing, and the failure it fails to prevent is unbounded identity growth on a
real class of site. Documenting that it does not work is worse than making it
work when the fix is twelve characters and the differential is five rows.

**Add every IIS spelling explicitly.** There are 26⁸ of them. Not a list.

**Make the whole session list prefix-matched.** Rejected, and it is the reason
this ADR exists rather than a one-line change: `sid` → `sidebar`, `ref` →
`refresh`, `source` → `sourced`. Each would be an identity collision of the class
ADR-0041 removed.

**Match with a regular expression** (`/^aspsessionid[a-z]{8}$/i`). Rejected as
more precise than the evidence supports — it asserts the suffix is exactly eight
letters, which is what IIS does today and not something this project has
measured across versions. `startsWith` is the claim actually being made.

**Strip on the value's shape rather than the name.** Rejected outright: a value
that looks like a session id is data. `?q=ASPSESSIONIDQWERTY` is a search for
that string, and stripping it would delete a real page's identity. Pinned by a
test.

## Consequences

### Positive

- Classic ASP sites with cookieless sessions no longer generate one crawl
  identity per visitor.
- The strip list's entries now all do something, which is the property that made
  the dead entry hard to notice for two audits.

### Negative

- **The strip list now has two matching rules instead of one**, and a reader must
  check which list a name is in to know how it matches. This is a real cost, paid
  to avoid the larger one.
- A query parameter genuinely beginning `aspsessionid` would be stripped. None
  was found in 80 realistic names, and the prefix is twelve characters, but the
  risk is not zero and it is the risk `sid`-as-a-prefix would have made severe.
- Every future addition to the prefix list needs its own differential. The test
  asserts the list is exactly `['aspsessionid']` so that growth cannot be silent.

## Verification

**8 new tests** in `packages/crawler/src/urls/normalise.test.ts`, of which **4
were observed red before the change** — one per realistic IIS name.

The tests assert both directions: the four IIS names are stripped, and the
near-misses (`asp`, `aspect`, `aspnet`, `aspx`, `asp_net`, `aspect_ratio`,
`aspire`) and the exact-match neighbours (`sidebar`, `sidetable`, `sid_type`,
`refresh`, `sourced`, `phpsessidx`) are all kept — the second group being the
proof that prefix matching did not leak to any other entry.

`STRIPPED_PARAMETERS.sessionPrefixes` is exported and asserted to equal
`['aspsessionid']`, so the list cannot grow without a test change and therefore
without a new differential.

Suite: **971 passed / 215 skipped (1186)**, against 957 / 215 (1172) before. 29
boundary probes.

## Related

- [ADR-0033](ADR-0033-url-normalisation.md) — the one definition of crawl identity
- [ADR-0041](ADR-0041-query-identity-preserves-bytes.md) — the identity collision this list must not recreate
- [dev log 0022](../development-log/0022-the-query-identity-collision.md) — where the dead entry was found
- [dev log 0024](../development-log/0024-three-claims-the-code-does-not-keep.md) — this work
