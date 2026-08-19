# ADR-0048 — Verification states both body tiers, and the inherited one was the looser half

**Status:** Accepted
**Date:** 2026-08-19

## Context

Dev log 0018 ranked this ninth of ten: `checkHtmlMeta` passes
`maxCompressedBytes: 1 MB` and omits `maxDecompressedBytes`, which merges in
from `DEFAULT_LIMITS` at 8 MB. ADR-0037's timing argument was written against a
1 MB ceiling that is 8 MB after decompression.

### Re-measured at `7ebf8e5`

0018's line numbers hold exactly, four sessions later:

| location                        | value                                                  |
| ------------------------------- | ------------------------------------------------------ |
| `sites/src/verification.ts:279` | `{ maxCompressedBytes: 1024 * 1024, maxRedirects: 3 }` |
| `net/src/http/fetch.ts:145`     | `maxDecompressedBytes: 8 * 1024 * 1024`                |
| `net/src/http/fetch.ts:203`     | `{ ...DEFAULT_LIMITS, ...options.limits }`             |

ADR-0037 states the premise in print: _"The caller accepts 1 MB bodies, so a page
the requester chose blocked the verification worker for roughly twenty seconds
per attempt."_ The first clause was never true after decompression.

### ⚠️ The timing argument survives, and that is the finding, not a problem

The brief asked whether 8 MB changes the safety margin ADR-0037 relied on. It
does not. `findMetaTokens` re-measured on ADR-0037's own adversarial shape,
extended past its table:

| input    | ADR-0037 recorded | re-measured | ms/MB |
| -------- | ----------------- | ----------- | ----- |
| 70 KB    | 2 ms              | 2.0 ms      | 28.5  |
| 280 KB   | 6 ms              | 3.4 ms      | 12.2  |
| 1.12 MB  | 14 ms             | 12.3 ms     | 11.0  |
| 4 MB     | —                 | 49.9 ms     | 12.5  |
| **8 MB** | —                 | **96.4 ms** | 12.1  |
| 16 MB    | —                 | 173.5 ms    | 10.8  |

Flat at ~11–12 ms/MB from 573 KB to 16 MB. The parse is linear, and 8 MB costs
96 ms against the ~20,000 ms the old regex cost at 1.12 MB. **ADR-0037's
conclusion is unaffected by its wrong premise** — it replaced a quadratic regex
with a linear parse, and linearity does not care where the ceiling sits.

A negative result, and the honest one: there is no timing emergency here.

### ⚠️ What is actually wrong is the ratio, not the number

Overriding one tier and inheriting the other does not just change a number, it
changes the relationship between them:

| caller                     | compressed | decompressed | permitted expansion |
| -------------------------- | ---------- | ------------ | ------------------- |
| `DEFAULT_LIMITS`           | 2 MB       | 8 MB         | **4×**              |
| `robots/fetch.ts:126`      | ceiling    | ceiling × 4  | **4×**              |
| `verification.ts` (before) | 1 MB       | 8 MB         | **8×**              |

Verification is the call site that deliberately asked to be _tighter_ than the
default, and ended up permitting _twice the expansion_. Nobody chose 8×; it is
what arrives when half a decision is written down.

The ratio is what an origin actually spends. Measured: 8 MB of ordinary markup
gzips to **24 KB**, and 8 MB of one repeated byte to **8 KB**. So a hostile
origin buys 8 MB of parser work for tens of kilobytes, and the compressed cap
never comes near firing.

### §5 — this is defence-in-depth, so it was measured rather than assumed

"Two-tier body caps" is named in the SSRF invariant. The exposure it changes is
~96 ms of linear parse per verification attempt, on an operator-triggered,
authenticated action. That is not a denial of service, and this ADR does not
claim it was one.

## Decision

**State both tiers at the call site, at the default's 4× ratio.**

```ts
limits: {
  maxCompressedBytes: 1024 * 1024,
  maxDecompressedBytes: 4 * 1024 * 1024,
  maxRedirects: 3,
},
```

### ⚠️ Neither of the two options the brief offered

The brief framed it as: the comment is wrong (should say 8 MB), or the code is
wrong (should cap at 1 MB decompressed). Measurement says neither.

- **The comment is not false.** It annotates `maxCompressedBytes`, and that value
  is 1 MB. It is _incomplete_ — it reads as the whole ceiling because the object
  beneath it names only one tier. Rewriting it to say "8 MB" would document the
  accident rather than remove it.
- **Capping decompressed at 1 MB is a change nothing measured asks for.** §1
  warns against manufacturing a change to justify a step, and the timing table
  above is exactly the evidence that 1 MB is unnecessary.

The third option is the one the measurement supports: the call site should state
what it accepts instead of half-stating it, and the value it states should not
silently be looser than the global default it overrode.

**4 MB is derived, not chosen.** It is `maxCompressedBytes × 4`, the ratio
`DEFAULT_LIMITS` and `robots/fetch.ts` both use. Any other number would be a new
opinion about how much expansion is reasonable; this one inherits the opinion
already in the codebase and applies it to the tightened wire cap.

### ⚠️ This is a behaviour change, and it is a tightening

A homepage decompressing to between 4 MB and 8 MB verified before and does not
now. Stated plainly rather than buried: nothing measured shows 8 MB was
dangerous, so this is chosen for consistency, not forced by evidence. The
direction is the safe one, and `fetch.ts`'s own comment — _"the 95th percentile
page is well under 200 KB"_ — puts a 4 MB homepage far outside anything real.

## ⚠️ Why this needed an ADR

The brief asked for a yes or no. **Yes**, and the reason is that the measurement
does not force the answer: three defensible directions exist, ADR-0037 rules out
none of them, and the one taken is not the one the brief expected. A future
reader finding `maxDecompressedBytes: 4 * 1024 * 1024` beside a 1 MB wire cap has
no way to recover "this preserves the default ratio" from the code, and deleting
the line restores the 8× inheritance while every test but one still passes.

## Alternatives considered

**Fix only the comment.** The minimal honest change, and genuinely defensible —
nothing measured shows 8 MB is unsafe. Rejected because it leaves the call site
making half a decision: the next person to tighten `maxCompressedBytes` to 256 KB
gets a 32× ratio without noticing, for the same reason this one got 8×.

**Cap decompressed at 1 MB.** The brief's second option. Rejected: no measurement
asks for it, it would refuse pages the 8 MB ceiling handles in under 100 ms, and
it treats a comment's phrasing as a requirement.

**Set it explicitly to 8 MB.** Behaviour-preserving, and it removes the sharp
edge. Rejected only because it writes down the 8× ratio as though it had been
chosen — which is how the accident becomes the documented intent.

**Change the merge semantics in `fetch.ts` so overriding one tier scales the
other.** The general fix, and the one that would prevent this class rather than
this instance. Rejected on scope (§3): it is a change to the shared network
boundary affecting every caller, and it needs its own brief and its own
measurement of the crawler and robots paths. Recorded in dev log 0029 as the
follow-up this work identifies.

## Consequences

### Positive

- The call site states what it accepts. Both tiers are visible where a reader
  looks for them.
- The expansion ratio at the tightest call site is no longer the loosest in the
  codebase.
- ADR-0037's premise is corrected in the record without disturbing its
  conclusion, which measurement confirms.

### Negative

- **A behaviour change with no measured defect behind it.** Pages between 4 MB
  and 8 MB decompressed now fail verification. Judged safe on ADR-0037's own
  95th-percentile reasoning, not on a measurement of real customer homepages,
  which this session did not take and could not.
- **The underlying sharp edge remains.** Every other caller that overrides one
  tier still inherits the other. `robots/fetch.ts` happens to set both;
  `verification.ts` now does too; nothing stops the next one.
- The 4× ratio is now asserted in three places by convention and in none by
  construction.

## Verification

**4 new tests** in `packages/sites/src/verification.test.ts`.

⚠️ **Every oversized page in them carries a valid verification tag.** That is
what makes the assertions strong: if the decompressed cap fails to fire, the
parser reaches the tag and verification _succeeds_, so `verified: false` proves
the limit stopped the body rather than that some error came back.

**1 of the 4 was observed red** before the change, by reverting only
`verification.ts` to `7ebf8e5` while keeping the tests. Stated precisely because
it is fewer than the test count suggests: the 8 MB case fires against an 8 MB
ceiling too, so it is a control, not a proof. "The enforced ceiling is 4 MB, not
the 8 MB it used to inherit" is the only assertion that distinguishes the change,
and it is the one that fails if the explicit `maxDecompressedBytes` is dropped.
The other three — an honest gzipped homepage verifies, the wire cap still fires,
a sub-1 MB compressed stream still gets stopped at the second tier — pass in both
states by design.

`verify:all` exit 0 at **1,117 passed / 230 skipped (1,347)**, against 1,113 / 230
(1,343) at `7ebf8e5`. 29 boundary probes.
