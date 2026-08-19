# ADR-0045 — One definition of "is this an http(s) location?"

**Status:** Accepted
**Date:** 2026-08-19

## Context

Dev log 0018 recorded four copies of `/^https?:\/\//i` and measured three
different answers for one input. Dev log 0025 moved one of them into
`landingPathOf` and listed the rest as remaining work.

### Re-measured this session, and the count was wrong twice

**There were five copies, not four.**

| site                                              | function               | in 0018? |
| ------------------------------------------------- | ---------------------- | -------- |
| `packages/sites/src/origin.ts`                    | `normaliseOrigin`      | yes      |
| `packages/forms/src/tracking/sanitise.ts`         | `toOrigin`             | yes      |
| `packages/contracts/src/forms/classify-source.ts` | `referrerHost`         | yes      |
| `packages/contracts/src/crm/provenance.ts`        | `landingPathOf`        | yes      |
| `packages/crm/src/identity/normalise.ts`          | `normaliseWebsiteHost` | **no**   |

`git merge-base --is-ancestor 483b708 50131ea` is true, so the fifth predates the
sweep that was meant to enumerate them — it was **missed**, not added afterwards.
0025's "three remain" is also wrong; it names neither `referrerHost` nor
`normaliseWebsiteHost`.

⚠️ Recorded because the enumeration failed the same way twice, in the same
direction, and both times the artefact reporting the count was trusted. 0018 also
recorded its own instrument under-counting by 8. A count nobody re-derived is not
a measurement.

### The 0018 disagreement table reproduces, with a fourth answer

Given `<TAB>https://evil.test`, executing all five:

| function               | returned            |
| ---------------------- | ------------------- |
| `normaliseOrigin`      | `https://evil.test` |
| `toOrigin`             | `https://evil.test` |
| `referrerHost`         | `https`             |
| `landingPathOf`        | `/`                 |
| `normaliseWebsiteHost` | `evil.test`         |

0018's claim holds exactly for its four — two, one, one — and `referrerHost` is
confirmed the only one that does not trim first. With the fifth it is **four
distinct answers across five functions.**

### ⚠️ But "four copies, three answers" describes the wrong defect

Over a 47-input corpus these are not five copies of one function. They are two
pairs and one guard:

- **Origin-returning** — `normaliseOrigin`, `toOrigin`. Agree on every input.
  Differ only in cap and in `null`/`undefined` spelling.
- **Host-returning** — `referrerHost`, `normaliseWebsiteHost`. Byte-identical
  bodies except that `referrerHost` omits `.trim()`. That single missing call is
  the **entire** disagreement between them.
- **`landingPathOf`** — uses the pattern as a _reject-guard_, not as a
  prepend-trigger, and fails closed. It shares no defect with the other four.

So there is one defect, in four places: **the prepend-and-parse idiom.**

### The defect, stated exactly

```ts
const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
```

The pattern and the parser are not asked about the same text. `new URL()`
removes ASCII tab, LF and CR from **anywhere** in the string, and maps `\` to `/`
for special schemes, _before_ it parses. The prepend happens in the gap.

| input                    | pattern | `new URL(raw)` host | `new URL('https://' + raw)` host |
| ------------------------ | ------- | ------------------- | -------------------------------- |
| `https:/\evil.test`      | false   | `evil.test`         | **`https`**                      |
| `<TAB>https://evil.test` | false   | `evil.test`         | **`https`**                      |
| `file:///etc/passwd`     | false   | _(none)_            | **`file`**                       |
| `mailto:a@b.test`        | false   | _(none)_            | **`b.test`**                     |
| `/contact`               | false   | _throws_            | **`contact`**                    |

Prepending **fabricates an authority** in four of five and **destroys a correct
parse** in two. `mailto:a@b.test` borrows the real domain `b.test` out of an
opaque part nobody linked to. `normaliseOrigin`'s docstring — _"Never a repaired
guess"_ — was false as written, and `/contact` → `https://contact` demonstrates
it more directly than the tab case does.

## ⚠️ §5 does not bind here, for the reason 0044 gives

"URL identity is singular" governs `normaliseUrl` in `@growth-os/crawler` —
whether two crawled pages are the same page. This is forms, CRM and site
registration, so the invariant does not reach it. The failure mode does: four
functions answering one question is how they drift, and they had.

This is also why the new module is deliberately **not** a normaliser. It answers
one question — is this an http(s) location — and returns a `URL`. Adding path,
query or case folding to it would create the second identity §5 exists to
prevent.

## Decision

**One parse step in `contracts`; four callers keep their own jobs.**

```ts
// packages/contracts/src/url/http-url.ts
export function httpUrlOf(input: string | null | undefined): URL | null;
```

1. Remove the characters the parser removes, then trim. Every test after this
   asks about the same text `new URL()` will see.
2. If a scheme is present (RFC 3986 §3.1, not `https?://`), **the parser is the
   only authority on what it means.** Not http(s) → `null`.
3. Otherwise the value must be a bare authority. A leading `/` is a path or a
   protocol-relative reference → `null`. Else prepend and parse.

Returning a `URL` rather than a string is what lets the four keep their jobs:
two take `.origin`, two take `.hostname` and strip `www.`.

### Why the scheme test is "is a scheme present", not "is it http(s)"

Collapsing those two questions **is** the bug. `/^https?:\/\//i` answers "is it a
scheme I like" and silently treats every other answer as "no scheme at all",
which is what licenses the prepend. Asking them in sequence means a value
carrying `file:` is refused instead of repaired.

### ⚠️ Scheme-less `host:port` is refused, and this is the one real cost

`abcplumbing.test:8080` is, per RFC 3986, the scheme `abcplumbing.test` with the
opaque part `8080`. Reading it as a host and a port is a guess about which of two
valid readings was meant — a guess browsers make in the address bar and
`new URL()` does not.

The previous idiom made that guess silently. This refuses. Measured consequences:

- **Site registration fails visibly and tells the user the fix.**
  `createSite` throws `ValidationError('Enter a website address like
https://www.example.com.')`.
- **A company website drops the weak identity signal and keeps the record.**
  `websiteHost` is null; the company is still created. The same shape ADR-0044
  established for a rejected landing path.
- Neither `Origin` headers nor referrers are affected — both are always absolute.

A digits-only-opaque-part exception was considered and rejected below.

## The differential

⚠️ This changes live behaviour in three places: the embed-origin check, source
classification, and company identity matching.

| corpus                                 | inputs | changed |
| -------------------------------------- | -----: | ------: |
| realistic — schemes, bare hosts, ports | **21** |   **3** |
| hostile                                | **26** |  **14** |

**All 14 hostile changes are improvements**, in two kinds:

- **Stops fabricating an authority (7 shapes × 4 functions).** `file:`,
  `mailto:`, `chrome:`, `ftp:`, `C:\Windows`, `//evil.test/x` and `/contact` all
  returned a plausible host; all now return null.
- **Starts resolving the way a browser does (3 shapes × 4 functions).**
  `ht<TAB>tps://evil.test`, `https:/\evil.test` and `https:\\evil.test` returned
  the fabricated `https`; all four now return `evil.test`.

The 3 realistic changes are **one fix and two refusals**:

| input                            | change                                                      |
| -------------------------------- | ----------------------------------------------------------- |
| `"  https://abcplumbing.test  "` | `referrerHost` null → `abcplumbing.test` — the missing trim |
| `abcplumbing.test:8080`          | all four → null                                             |
| `localhost:3000`                 | all four → null                                             |

Nothing else in the realistic corpus moves: absolute URLs with and without ports,
credentials, uppercase, subdomains, punycode, bare hosts, `www.` forms and paths
are all unchanged.

## Alternatives considered

**Dedupe the two pairs, leave the idiom.** Collapses five copies to two and adds
the missing `.trim()`, with no other behaviour change. Rejected: it leaves
`normaliseOrigin('/contact') === 'https://contact'` in place, which is the
finding, and makes the remaining copies look reviewed.

**Document five behaviours and change nothing.** 0018's second option, and a
complete outcome under §1. Rejected because the divergence is not the whole
defect — all four agreed on `file:///etc/passwd` → host `file`, so documenting
their disagreement would leave the shared error undocumented.

**Accept `host:port` when the opaque part is digits and ≤ 65535.** Decidable, not
a heuristic, and it would keep the two realistic refusals. Rejected: it
reintroduces exactly the shape this ADR removes — a rule that guesses which of
two valid readings the author meant — and it is one line to add later if the
measured cost turns out to matter. The refusal is recorded rather than hidden.

**Apply the parser's own pre-cleaning and keep the prefix pattern.** Fixes the
tab/LF/CR cases but not `\`-mapping, not `file:`, not `/contact`. A partial fix
to the case that was reported rather than to the defect.

**Put `httpUrlOf` in `@growth-os/sites` or `@growth-os/forms`.** Rejected on
direction: `contracts` depends on nothing and all three packages already import
from it; the reverse edges do not exist and should not be created for this.

**Route `landingPathOf` through it too.** Rejected. It asks a different question —
"is this a landing path" — and its guard fails **closed** where the other four
failed open. `httpUrlOf` accepts a bare authority, which is exactly what a
landing path must not be. Making them share would widen the one function that
was already correct.

## Consequences

### Positive

- One definition, called by four functions in three packages, with a property
  test asserting they still agree on every input in the corpus.
- Seven hostile shapes stop producing a fabricated authority; three start
  resolving the way a browser resolves them.
- `referrerHost` no longer differs from its twin by a missing `.trim()`.

### Negative

- **Scheme-less `host:port` is refused**, measured above. The only realistic
  regression, and it is silent for company websites.
- **A cross-package runtime call in three more places.** `sites`, `crm` and
  `forms` each already imported `contracts`; this makes the edge load-bearing for
  origin parsing.
- **`referrerHost` and `normaliseWebsiteHost` are now byte-identical.** They live
  in different packages for different domains and were left as two functions:
  collapsing them is a further refactor this ADR does not make, and it is now
  duplication of three lines rather than of a decision.
- **A fifth copy remains by design.** `landingPathOf` still holds
  `/^https?:\/\//i`. It is a reject-guard that fails closed, argued above.
- `normaliseOrigin`'s 255-character cap and the `'null'` sentinel check stay with
  their callers, so those two still differ from the host-returning pair on those
  two inputs. Deliberate — the sentinel is meaningful only to a browser header.

## Verification

**99 new tests**, all observed: 45 in `packages/contracts/src/url/http-url.test.ts`,
54 appended to `packages/forms/src/public/public-path.test.ts`. Full suite
**1,088 passed / 223 skipped (1,311)**, against 989 / 223 (1,212) at `f98aeb3`.

**7 were observed red before the change**, by reverting only the four call sites
to `f98aeb3` while keeping the helper and the tests, then restoring. The
negative control: `http-url.test.ts`'s 45 passed in **both** states, which is
what makes the other 7 a measurement rather than an assertion.

⚠️ The red set is smaller than the changed set, and the reason is worth keeping:
the "all four accept or all four refuse" property failed on only **one** input,
because on the hostile shapes the old code agreed to accept and disagreed about
_what_. Agreement on admission is the weaker property. The value assertions are
what caught the rest.
