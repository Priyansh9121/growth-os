# ADR-0049 — A limits override supplies both body tiers or neither

**Status:** Accepted
**Date:** 2026-08-19

## Context

ADR-0048 fixed one call site. `checkHtmlMeta` stated `maxCompressedBytes: 1 MB`
and inherited `maxDecompressedBytes: 8 MB` from `DEFAULT_LIMITS`, so the caller
that deliberately asked to be the strictest in the codebase ended up permitting
twice the expansion of the default. That was fixed at the call site. **The merge
that allowed it was not.**

### Re-measured at `fecbc1d`

The merge is still `fetch.ts:203`, still a spread:

```ts
const limits = { ...DEFAULT_LIMITS, ...options.limits };
```

with `limits?: Partial<ResponseLimits>`.

**Both production callers now pass all three fields**, so the defect is latent
rather than live: `robots/fetch.ts:124` always set all three, and
`verification.ts:298` was fixed by ADR-0048. That is worth stating plainly —
nothing is currently broken.

### ⚠️ The magnitude scales the wrong way

Every `limits` object any caller has ever passed, and the ratio it resolves to:

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
the worst. A caller asking for a 1 KB body inherits permission to decompress to
8 MB.

### One caller shrinks rather than grows

`fetch.test.ts:513` caps decompressed (1 MB) _below_ compressed (2 MB) — the
compression-bomb test, deliberately. Measured before designing anything, because
it rules out an entire family of fixes: **any merge that derives one tier from
the other by a ratio would be wrong for this caller**, and would silently
override a deliberate choice.

## Decision

**The two body tiers are one decision. They are supplied together or not at all.
`maxRedirects` is independent and may be given alone.**

```ts
export type LimitsOverride =
  | {
      maxCompressedBytes?: never;
      maxDecompressedBytes?: never;
      maxRedirects?: number;
    }
  | {
      maxCompressedBytes: number;
      maxDecompressedBytes: number;
      maxRedirects?: number;
    };

export function resolveLimits(
  override: LimitsOverride | undefined,
): ResponseLimits;
```

`resolveLimits` replaces the spread. A half-stated body override throws.

### Why a type AND a runtime check, measured rather than assumed

The type was tested before being relied on. A `@ts-expect-error` control
confirmed the mechanism was live (TS2578 fires when the directive is unnecessary),
and with it live:

- `{ maxCompressedBytes: 1 }` as an **object literal** — rejected. ✅
- A value typed `Partial<ResponseLimits>` assigned to the union — **compiles.**

So the type closes the case every call site in this repository is written as, and
leaves a hole for a value assembled elsewhere. §6 asks for the strong property,
and a compile-time guarantee with a measured hole is not it. The runtime check
closes the hole and is the half a test can prove.

### ⚠️ Why it throws, in a function that never throws

`safeFetch` returns `ok: false` for every failure and throws nothing. Adding a
throw is a new convention here and was not done lightly.

Every member of `FetchFailure` describes something a **remote host or the
security pipeline did** — `ssrf_blocked`, `dns_failure`, `redirect_limit`,
`response_too_large`. Callers treat them as expected outcomes: `fetchRobots`
fail-closes on any failure, returning "this site disallows crawling".

A half-stated limits object is none of those. It is a programming error, and
routing it through that channel would turn a developer's typo into a silently
uncrawlable site — the same class of silent-wrong-answer this ADR exists to
remove. It cannot be triggered by network input; reaching it requires
circumventing the type.

### Why not the alternatives

**Require the full `ResponseLimits`.** Totally type-safe with no runtime check —
`Partial<ResponseLimits>` is not assignable to `ResponseLimits`, so the hole
closes completely. Rejected because it misstates the invariant: it couples
`maxRedirects` to the body tiers, so a caller wanting only a shorter redirect
chain must restate both body caps, and copy-pasting stale values is a new way to
acquire a ratio nobody re-checked.

**Derive the missing tier from the default ratio.** Rejected by measurement:
`fetch.test.ts:513` deliberately shrinks, and deriving replaces one number the
caller did not state with a different number the caller did not state. §6 asks
for a _stated_ ratio, not a consistent one.

**Nest the pair as `limits.body`.** Structurally bulletproof — `BodyLimits`
requires both fields, so there is no union subtlety and no runtime check needed.
Rejected on churn against benefit: it changes the option shape at every call
site, including three tests, to close a hole the runtime check closes in four
lines.

**Leave it; both production callers pass all three.** The honest do-nothing
option, and the reason this is not urgent. Rejected because the next caller is
the whole point: §5 names two-tier body caps as part of SSRF defence-in-depth,
and a defence that depends on each future author remembering to state both
halves is a convention, not a structure.

## Consequences

### Positive

- A caller cannot acquire an expansion ratio it did not choose. The property is
  asserted over a corpus rather than checked per call site.
- The failure is loud and at the call site, not a silent number three files away.
- `maxRedirects` stays independently overridable, which is what it is.

### Negative

- **`safeFetch` can now throw**, for the first time. Argued above, and confined
  to a shape the type rejects — but it is a real change to the function's
  contract, and a caller building limits dynamically must handle it.
- **Two test callers had to change** to state a tier they previously inherited.
  Neither assertion changed: both prove the compressed rule, and the decompressed
  value was chosen above it so the same rule still bites. Verified by running
  them.
- **The type's hole is closed at runtime, not compile time.** A dynamically-built
  partial object typechecks and fails when it runs. Better than silently
  resolving, worse than impossible.
- The 4× ratio remains a convention across three call sites, not a constraint.
  Nothing forces a caller to pick a sane ratio — only to state the one it picks.

## Verification

**8 new tests** in `packages/net/src/http/fetch.test.ts`.

**3 were observed red** by restoring the old spread semantics inside
`resolveLimits` while keeping its signature and the tests, then reverting: the
two half-stated refusals and the ADR-0048 regression case.

⚠️ **The two PROPERTY tests passed in both states, and that is not a defect in
them.** They can only exercise overrides that resolve — a half-stated one throws
— so under the old semantics they see the same full-or-empty objects and agree.
They document the invariant; the three refusal tests are what catch a regression.
Stated because five of eight new tests not moving would otherwise look like weak
coverage.

`verify:all` exit 0 at **1,141 passed / 230 skipped (1,371)**, against 1,117 / 230
(1,347) at `fecbc1d`. 29 boundary probes.
