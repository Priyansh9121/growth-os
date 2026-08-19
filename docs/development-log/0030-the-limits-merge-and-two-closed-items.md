# 0030 — The limits merge, and two items closed instead of carried a fifth time

**Date:** 2026-08-19 · **Stage:** 4

## Objective

1. Fix `safeFetch`'s limits merge so overriding one body tier cannot silently
   inherit a ratio from the other. ADR-0048 fixed one call site; the merge that
   allowed it was untouched.
2. Decide the two items dev log 0029 proposed closing and explicitly left to the
   project. **"Still applies, still carried" was not an available outcome.**

## Initial state

Verified, not recalled: `fecbc1d`, tree clean, `verify:all` exit 0 at **1117
passed / 230 skipped (1347)**, 29 boundary probes, remote PRIVATE, 0 ahead / 0
behind. Matched the brief exactly.

## Part 1 — the merge

### Re-measured (§0/§1)

Still `fetch.ts:203`, still `{ ...DEFAULT_LIMITS, ...options.limits }` with
`limits?: Partial<ResponseLimits>`.

⚠️ **Both production callers already pass all three fields**, so the defect is
latent, not live — `robots/fetch.ts:124` always did, and `verification.ts:298`
was fixed by ADR-0048. Nothing is currently broken, and saying so is part of the
result.

### The magnitude scales the wrong way

Every `limits` object any caller has ever passed:

| caller                        | compressed | decompressed | ratio     | stated?        |
| ----------------------------- | ---------- | ------------ | --------- | -------------- |
| `DEFAULT_LIMITS`              | 2.00 MB    | 8.00 MB      | 4×        | yes            |
| `robots/fetch.ts:124`         | 2.00 MB    | 8.00 MB      | 4×        | yes            |
| `verification.ts:298`         | 1.00 MB    | 4.00 MB      | 4×        | yes            |
| `fetch.test.ts:469` (partial) | 4096 B     | 8.00 MB      | **2048×** | NO — inherited |
| `fetch.test.ts:490` (partial) | 1024 B     | 8.00 MB      | **8192×** | NO — inherited |
| `fetch.test.ts:513` (both)    | 2.00 MB    | 1.00 MB      | 0.5×      | yes            |

**The tighter the wire cap a caller asks for, the looser the expansion it
silently accepts.** ADR-0048's 8× was the mildest instance in the repository, not
the worst.

⚠️ **One caller shrinks rather than grows.** `fetch.test.ts:513` caps
decompressed _below_ compressed, deliberately, for the compression-bomb test.
Measured before designing anything, and it rules out an entire family of fixes:
any merge deriving one tier from the other would silently override that choice.
That is the §1 instruction — check every current caller against a proposed
semantics — earning its place.

### The decision

The two body tiers are one decision: supplied together or not at all.
`maxRedirects` is independent. `resolveLimits` replaces the spread and throws on
a half-stated override. ADR-0049 has the argument.

### ⚠️ The type was tested before being relied on

A `@ts-expect-error` control confirmed the mechanism was live — TS2578 fires when
the directive is unnecessary — and with it live:

- `{ maxCompressedBytes: 1 }` as an **object literal** → rejected ✅
- a value typed `Partial<ResponseLimits>` → **compiles** ❌

So the type closes the case every call site here is written as, and leaves a hole
for a value assembled elsewhere. That measurement is why there is a runtime check
as well as a type. Without it I would have shipped the type alone and called it
proven.

### Testing

**8 new tests. 3 observed red** by restoring the old spread inside
`resolveLimits` while keeping its signature and the tests.

⚠️ **The two PROPERTY tests passed in both states, and that is not weak
coverage.** They can only exercise overrides that resolve — a half-stated one
throws — so under the old semantics they see the same objects and agree. They
document the invariant; the three refusal tests catch the regression. Said
plainly because five of eight not moving would otherwise read as thin.

Two existing test callers had to state a tier they previously inherited. Neither
assertion changed — both prove the compressed rule, and the decompressed value
was set above it so the same rule still bites. Verified by running them, not
assumed.

## Part 2 — the two carried items, now closed

### ⚠️ `splitLandingUrl` is not dead code — ACCEPTED

Four dev logs have recorded it as "dead: definition and tests only". Measured
this session, that description is wrong in a way that changes the decision.

`public-path.test.ts:374` is a property test — _"agrees with `splitLandingUrl` on
every input"_ — asserting over 15 inputs that `toPath` and `splitLandingUrl`
agree on accept/reject **and** on the path. `splitLandingUrl` is the
**differential oracle** in the test that stops the live path drifting from the
definition ADR-0044 preserved it for.

So it has no _production_ caller, which is not the same as being dead. Deleting
it would delete the counterparty of the test that exists because these two
functions once disagreed about 7 of 13 inputs.

**Closed as accepted.** Not carried again, and the wording corrected: it is a
test oracle, not dead code.

### `referrerHost` / `normaliseWebsiteHost` — FIXED

Both were still byte-identical bodies. Both already delegated to `httpUrlOf` for
the parse — the half that had actually diverged and was fixed by ADR-0045. What
remained was three lines: lowercase the hostname, strip `www.`.

Extracted as `bareHostOf` into `contracts/src/url/http-url.ts`, beside
`httpUrlOf`. Both callers now delegate.

⚠️ **No ADR.** This is the fourth application of a precedent ADR-0045 already
argued in full, the module and the import direction both already exist, and the
change is a net reduction. An ADR here would restate a decision rather than
record one. Saying so explicitly, because the brief asked for the question to be
answered either way.

The reasoning that made it a fix rather than an accept: _"they might legitimately
diverge later"_ is a hypothesis with no evidence, and they are identical **now**.
If they should diverge, that should be a deliberate edit with a stated reason,
not a divergence that already exists. What stays with each caller is the domain
rule — that a referrer host selects a source platform, that a website host is a
company dedup signal. Only "what is the host" is shared, and that is a URL fact.

⚠️ `bareHostOf` strips `www.` where `normaliseOrigin` deliberately must not: to a
browser those are different origins. Asserted as a test rather than left to the
next reader.

## Files

```
packages/net/src/http/fetch.ts                   LimitsOverride, resolveLimits
packages/net/src/http/fetch.test.ts              8 tests; 2 callers state both tiers
packages/contracts/src/url/http-url.ts           bareHostOf
packages/contracts/src/url/http-url.test.ts      16 tests
packages/contracts/src/forms/classify-source.ts  referrerHost delegates
packages/crm/src/identity/normalise.ts           normaliseWebsiteHost delegates
docs/decisions/ADR-0049-limits-override-couples-the-body-tiers.md
docs/development-log/0030-the-limits-merge-and-two-closed-items.md
docs/decisions/README.md, docs/development-log/README.md   index rows
```

## Testing

`verify:all` exit 0: **1,141 passed / 230 skipped (1,371)**, against 1,117 / 230
(1,347) at the start. 29 boundary probes.

No migration was touched (0 files under `packages/database/migrations`), so §7.2
has nothing to apply.

## Result

The general form of ADR-0048's defect is closed: a caller can no longer acquire
an expansion ratio it did not state, and the measurement showed the instance
ADR-0048 found was the mildest of three, not the worst.

**Two items are off the backlog for the right reason rather than by fiat.** One
turned out to be misdescribed — `splitLandingUrl` is a test oracle, and four dev
logs called it dead — and the other was small enough that arguing about it a
fifth time cost more than fixing it.

⚠️ The thing this session would have got wrong without measuring is the type. A
union that rejects half-stated object literals looks like a complete guarantee,
and it is not; a `Partial<ResponseLimits>` assembled elsewhere compiles against
it. The runtime check exists because a `@ts-expect-error` control and one
assignability probe said the type alone was not enough.

## Remaining work

Nothing from 0018 is on a live write path; its list is closed.

1. **`fieldKey` / `customFieldKey`** — the unbounded-quantifier-behind-`.max()`
   shape ADR-0046 fixed on `fieldTarget`. Two one-line bounds plus tests. Linear
   cost, so not urgent. Its own brief.
2. **threat-model T12** — one paragraph, naming form-submitted context and that
   it is live before Stage 7.
3. **`publicSubmissionSchema` key count** — measured in 0029 as bounded in
   practice by the route's 32 KB cap (3,384 keys, 3.20 ms). Propose closing as
   accepted, on the same basis as this session's two.
4. **The local dev database** at migration 0007 — operational, not a code change.
5. The client-side email regex, permanently deferred per 0018.

⚠️ New, from this session: the 4× expansion ratio is a **convention** across
three call sites and a constraint nowhere. `resolveLimits` forces a caller to
state its ratio; nothing forces the ratio to be sane. Whether that should be
bounded — a maximum expansion factor rejected at resolve time — is a real
question this work deliberately did not answer.
