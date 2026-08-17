# 0018 — The regex sweep, and what it found that was not a regex problem

**Date:** 2026-08-17 · **Stage:** 4

## Objective

Audit every regular expression in the repository that runs over
attacker-controlled input. **Report only — fix nothing.**

[0017](0017-the-permission-boundary-was-a-regex.md) named the argument for this
brief: the robots pattern matcher is a deliberate two-pointer scan built to
avoid catastrophic backtracking, and `findMetaToken` — same repository, same
stage, days apart — was a regex with quadratic backtracking and 32 false
positives. The discipline existed and was applied unevenly. Two more parsers
land in the next two briefs, so this was the cheap moment.

## Initial state

Verified, not recalled: `50131ea`, tree clean, `verify:all` **882 passed / 208
skipped (1090)**, 29 boundary probes, remote PRIVATE and in sync.

Two contract amendments landed first as `4905724` (§2 parallel agents may
investigate but never build; §4 the dev log lands with its slice). Everything
below was done under those rules — four read-only agents, no agent writing
source, every severe claim re-verified by hand.

## Investigation

### The enumeration found its own bug first

A lexer over the 253 tracked source files — rather than grep, so that comments,
string literals and division are not mistaken for regex literals. First run:
**44** occurrences in non-test source. That was wrong. It skipped template
literals whole, and `` `${origin.replace(/\/$/, '')}/` `` hides a regex inside
one. Descending into `${…}` substitutions recovered **8 more**.

Final inventory: **150 total — 148 literals and 2 `new RegExp`**. 98 live in
test files. Of the **52** in non-test source, 4 are false positives (three
`#!/usr/bin/env` shebangs and one division), leaving **48 real ones**.

⚠️ Recorded because the measurement instrument was wrong in the same direction
as the thing it measured: a pattern that could not see the structure it was
scanning. The sweep's own tool had the defect the sweep was hunting.

### The harness was validated against a known answer

Before trusting any negative result, the old `findMetaToken` pattern was
re-measured on this machine: **80.7 ms / 322.5 ms / 1,295 ms** at 70 KB / 140 KB
/ 280 KB, against the **88 / 395 / 1,642** recorded in ADR-0037. The harness
reproduces a known quadratic curve, so "measured linear" from it means
something.

## Findings, part 1 — TIMING

**Exactly one regex in the repository backtracks superlinearly.**

`apps/web/src/components/forms/form-renderer.tsx:88`, the client-side email
check `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Against `a@` + `b.`×k + `@` — a trailing
`@` the final `[^\s@]+$` can never consume:

| bytes  |       ms | ratio (size 2×) |
| ------ | -------: | --------------- |
| 1,000  |     0.41 | —               |
| 8,000  |    24.55 | 3.99×           |
| 32,000 |   407.84 | 4.17×           |
| 64,000 | 1,734.36 | 4.25×           |

4× per doubling is O(n²) — the same curve as `findMetaToken`. A 1 MB paste
extrapolates to roughly seven minutes, which is how it was found: it hung the
measurement job.

**Severity: low, and the file already says why.** The comment above it reads
_"Client-side validation is a COURTESY, not a control — the server validates
everything again."_ It runs in the visitor's own browser, on a value the visitor
typed. `readUrlAttribution` reads only `utm_*`, `gclid` and `fbclid` from the
query string, each sliced to 255, so **the email field cannot be prefilled from
a link** — there is no reflected path to a stranger's browser. The victim is
whoever pastes 64 KB into an email box.

It is reported because it is the only one, because it is the same class the
previous session removed, and because this pattern copied server-side would
stop being a courtesy.

### Everything else is linear or flat

Every other attacker-facing pattern measured ≤ ~11× per 10× size step. The
caps each actually runs under, verified in code rather than assumed:

| pattern                                          |                  cap, verified | worst measured            |
| ------------------------------------------------ | -----------------------------: | ------------------------- |
| `robots/parse.ts:152` split                      |    **512,000** (`parse.ts:57`) | 10.77 ms (bare `\r`×512K) |
| `urls/normalise.ts:242` percent-decode           |               none of its own¹ | 6.72 ms at 512 KB         |
| `urls/normalise.ts:231` `/\+/g`                  |               none of its own¹ | 7.30 ms at 512 KB         |
| `urls/normalise.ts:246` unreserved test          | one character, by construction | 0.000 ms                  |
| `frontier.ts:238`, `robots/fetch.ts:116` `/\/$/` |      origin, already validated | 0.000 ms **at 1 MB**      |
| `net/url/policy.ts:129` param split              |        2,048 (`policy.ts:148`) | 0.11 ms full `admitUrl`   |
| `net/transport.ts:161,172` bracket strip         |          253 (`policy.ts:191`) | 0.00217 ms                |
| `net/address/classify.ts:123` hextet             |       **4** (`classify.ts:85`) | 0.000125 ms               |
| `apps/web/src/server/http.ts:46` req-id          |     none; Node's 16,384 header | 0.0003 ms **at 10 MB**    |

¹ `normaliseUrl` has no length bound — only an empty check at
`normalise.ts:139`. The 2,048 ceiling applies later, at `admitUrl`. For these
two regexes that is merely untidy: both are linear, so an oversized URL costs
milliseconds. **It stops being untidy one section below**, where the same
uncapped path reaches the robots matcher and costs 12.5 seconds.

**A class worth naming, because it looks alarming and is not:** an anchored
pattern whose every quantifier has a finite upper bound — `{32}`, `{8,64}`,
`{6}`, `{1,4}` — never scans the string at all. `http.ts:46` costs the same
0.0003 ms on 10 MB as on 16 KB. The engine tries one start offset, consumes at
most 64 characters, and gives up. Not "fast enough": **structurally independent
of input length.**

### ⚠️ The positive control is the worst finding in this audit

`matchesPattern` (`parse.ts:404`) is the two-pointer scan the whole sweep was
told to treat as the standard. Measured against 10,000 `*` wildcards and a
20,002-character path: **0.22 ms**, where the same shape compiled as a regex
with only 10 nested groups against a **42-character** path takes **3,878 ms**
and 15 groups does not finish in five minutes. The claim at `parse.ts:391` —
that a regex here would be "a denial of service delivered as a text file" — is a
17,000× measurement, not rhetoric.

**And that measurement was the wrong one.** I chose the adversarial input from
the docstring, which names `/a*a*a*…*b` — the shape that destroys a _regex_
engine. It is not the shape that destroys _this algorithm_. The single-backtrack
scan is slow when long **literal runs** sit either side of one star, because
every star retry re-compares the whole literal:

| pattern (2,003 chars)                 |  target 10 K |  target 100 K |
| ------------------------------------- | -----------: | ------------: |
| `/a*a*a*…b` — the docstring's shape   |      0.17 ms |       1.39 ms |
| `/` + `a`×1000 + `*` + `a`×1000 + `b` | **49.47 ms** | **602.52 ms** |

A 350–430× difference between the payload the comment defends against and the
one an attacker would actually write.

`isAllowed` (`parse.ts:333`) then loops that over every rule in the group. A
604,214-character robots.txt — truncated to the 512,000 cap, yielding 255 rules —
against a path the crawler discovered:

| path length |    blocking CPU |
| ----------- | --------------: |
| 1,000       |          2.6 ms |
| 5,000       |      4,695.4 ms |
| **10,000**  | **12,530.2 ms** |

**12.5 seconds of blocked, single-threaded event loop from two inputs an
attacker supplies**: the robots.txt is fetched from the target site, and the
path comes from `normaliseUrl`, which caps nothing. This is the same failure the
previous session measured at ~20 s for `findMetaToken` — arrived at by a
different route, in the code held up as the example of avoiding it.

⚠️ To be exact about what is and is not wrong: the algorithm meets its stated
design goal. There is no exponential case, and no input makes it catastrophic.
Its cost is `O(rules × pattern × target)`, which the docstring describes
accurately — **nobody multiplied it out.** A polynomial denial of service is
still a denial of service.

**The mitigation is a cap that already exists elsewhere.** `MAX_URL_LENGTH =
2048` is defined at `policy.ts:137` and enforced at `admitUrl` — three steps
_after_ the matcher runs. Measured against the same 255 hostile rules:

| path capped at | blocking CPU |
| -------------- | -----------: |
| **2,048**      |  **55.0 ms** |
| 4,000          |   3,113.0 ms |
| 10,000         |  12,512.9 ms |

One length check inside `normaliseUrl` recovers **227×**. It also bounds the two
`normalise.ts` regexes above, which is why the missing cap is ranked as one
finding and not three.

A genuine mitigating discovery, found only by running it: the 512,000-byte parse
cap binds _before_ `maxRules = 2000` (`parse.ts:59`), so a hostile file yields
**255** rules rather than 2,000. The caps compose better than reading them
separately suggests. It is still 12.5 seconds.

## Findings, part 2 — STRUCTURE FROM TEXT

Reported separately because they need a different fix and a different argument.
A pattern can be perfectly linear and still be wrong, because it has no notion
of what a comment, a quoted field, an escape character or a directive is.

**Of the regexes, this is where the findings are. The timing audit found one
superlinear regex, and its worst result was not a regex at all.**

### ⚠️ 1. Robots: a missing colon fails OPEN — crawl admission

`parse.ts:191` uses `line.indexOf(':')` and assumes the colon is the only
field/value separator. Google's parser explicitly does not, and says so in a
comment upstream: _"some people forget the colon, so we need to accept
whitespace in its stead."_

Verified by executing the real module:

| robots.txt                           | groups | `/admin/customers`              |
| ------------------------------------ | -----: | ------------------------------- |
| `User-agent: *` / `Disallow: /admin` |      1 | refused, `longest_match`        |
| `User-agent: *` / `Disallow /admin`  |      1 | **FETCHED**, `no_rule_matched`  |
| `User-agent *` / `Disallow /admin`   |      0 | **FETCHED**, `no_group_matched` |
| `User-agent\t*` / `Disallow\t/admin` |      0 | **FETCHED**                     |

RFC 9309 requires the colon, so this is RFC-conformant. It is **not** conformant
with the standard this file sets for itself: `maxBytes` is justified in-file as
Google's documented ceiling, _"the least surprising choice for a site owner who
tested against Google."_ A site owner who typo'd the colon, tested against
Google and saw `/admin` respected will be crawled by us.

### ⚠️ 2. Robots: truncation turns a Disallow into an Allow — crawl admission

`parse.ts:142` does `body.slice(0, maxBytes)` — a character offset applied to
text with line structure. It cannot see where a directive ends. Verified on a
512,012-character file whose cut lands inside the final value:

```
…\nUser-agent: *\nDisallow: /private\nAllow: /private-public-page
                                            ↑ cut at 512,000
```

| URL                        | untruncated                    | truncated                      |
| -------------------------- | ------------------------------ | ------------------------------ |
| `/private`                 | refused — `Disallow: /private` | **allowed** — `allow_wins_tie` |
| `/private/secret-invoices` | refused                        | **allowed**                    |

`Allow: /private-public-page` becomes `Allow: /private`, ties the Disallow on
effective length, and **Allow wins the tie** — opening the whole subtree.
`truncated: true` is set, and `fetch.ts:152` uses it only to change a `detail`
string. Nothing fails closed on it.

This contradicts the module's own header: _"Every ambiguity below resolves
toward not fetching."_

Both of these are the crawl permission boundary, which is what the previous
session was also repairing. Per the brief: reported, not fixed.

### 3. URL identity: the query is decoded and re-encoded — §5 invariant

`normaliseQuery` (`normalise.ts:210-232`) runs the query through
`URLSearchParams`, which decodes to a JS string and re-encodes. Bytes that are
not valid UTF-8 become U+FFFD, unrecoverably. On a legacy Latin-1 site — an
ordinary shape:

```
/search?q=Fran%E7ois ┐
/search?q=Fran%E8ois ├→ /search?q=Fran%EF%BF%BDois
/search?q=Fran%E9ois ┘
/search?q=caf%E9     ┐
/search?q=caf%E8     ┴→ /search?q=caf%EF%BF%BD
```

Verified: **5 distinct URLs → 2 identities.** The same bytes in the _path_
survive untouched (`/produits/caf%E9` → `/produits/caf%E9`), so the two halves
of one URL are normalised under incompatible rules.

Worse than a fold: `frontier.ts:179` stores only the normalised form and
discards the original, so the crawler **fetches a URL the site never linked**,
and that string keys the durable `site_pages(site_id, normalised_url)` index.
§5 says URL identity is singular. It is singular, and wrong — permanently,
across crawls, which is architectural horizon #1.

⚠️ The three named percent-encoding patterns nearby (`:231`, `:242`, `:246`) are
**sound by construction** — see the negative results. The defect is beside them,
not in them.

### 4. Four copies of "is this an absolute URL", three answers

`/^https?:\/\//i` appears four times: `sites/origin.ts:46`,
`forms/tracking/sanitise.ts:82`, `contracts/forms/classify-source.ts:82`,
`contracts/crm/provenance.ts:157`.

The prefix test is unsound because `new URL()` strips ASCII tab, LF and CR from
anywhere in the string and maps `\` → `/`. So a string a browser resolves to
`https://evil.test` fails the test, gets `https://` prepended, and parses with a
different authority — `https:/\evil.test` → host `https`. Non-http schemes whose
name is a valid hostname do the same: `file:///etc/passwd` → `https://file`.

Given `\thttps://evil.test`, the four disagree: two return `https://evil.test`,
one returns `https`, one returns `/`. `referrerHost` is the only one that does
not trim first.

`normaliseOrigin`'s docstring — _"Never a repaired guess"_ — is false as
written.

**No security boundary crosses here, and one is unavailable by construction:**
`isOriginAllowed` runs the candidate _and_ the allow-list entry through the same
normaliser, so a confused input fails closed, and anyone able to forge an
`Origin` header can just send the allowed value verbatim. Data-quality defect,
ranked accordingly.

### 5. A documented security control with zero callers

`neutraliseCsvFormula` (`lifecycle.ts:523`) guards CSV formula injection on
export. There is no CSV export in this repository — `crm/src/import/csv.ts` only
reads. Confirmed: the only references are its definition and its test file.

Meanwhile `docs/security/data-lifecycle.md:93` lists it in a Risk/Control table
as the live control for "Formula injection (export)". A future author of an
export path has a security document telling them the problem is already solved.

The guard also only inspects index 0, so a leading space, BOM, NBSP or LF
defeats its own stated rule. Whether a spreadsheet still evaluates the formula
after those is **a hypothesis I could not measure** — no spreadsheet in this
environment. Stated as unverified rather than asserted.

`splitLandingUrl` (`provenance.ts:145`) is likewise dead — definition and tests
only — while its docstring describes ingestion wiring that does not exist.

### 6. The CRM search escaper does not escape the escape character

`contacts/service.ts:321`, `companies/service.ts:105`, `erasure.ts:314` all
build `` `%${term.replace(/[%_]/g, m => `\\${m}`)}%` ``. That escapes the two
LIKE metacharacters and not `\`, which is the character giving them their
meaning.

Verified against the running Postgres. A user searching for `a\` produces the
pattern `%a\%`, in which the closing wildcard is consumed as an escaped literal:

| subject       | as built | correctly escaped |
| ------------- | -------- | ----------------- |
| `Sara\Jones`  | **no**   | yes               |
| `Joanna\Bell` | **no**   | yes               |
| `Sara%`       | **yes**  | no                |

A false negative and a false positive from one missing character. Not
injection — the value is still parameterised — but `erasure.ts:314` is
`countTracesOf`, the helper the integration suite uses to prove GDPR erasure by
searching for the old name. A verification helper that can silently under-report
is §6's "prove the strong property" failing in the direction that looks green.

## Findings, part 3 — caps, which are neither timing nor structure

Three things surfaced that a regex sweep is simply the occasion for.

**`.max()` in zod does not gate `.regex()`.** Measured on zod 4.4.3 by
instrumenting `RegExp.prototype.test`: `z.string().max(48).regex(…)` against
200,000 characters **ran the regex at full length** and then reported
`too_big`. Zod v4 runs every check and collects all issues. A `.max()` bounds
what is accepted, never what is examined — which invalidates the obvious reading
of several contracts patterns.

**`fieldTarget` (`contracts/forms/schemas.ts:56-64`) has no `.max()` at all.**
Measured: a 200,007-character `custom:aaa…` value **parses successfully** and
flows into the stored config. A data-integrity defect, not a timing one.

**Site verification accepts 8 MB, not the 1 MB its comment implies.**
`verification.ts:279` passes `maxCompressedBytes: 1 MB` and omits
`maxDecompressedBytes`, which merges from `DEFAULT_LIMITS` at `fetch.ts:203` —
`8 * 1024 * 1024` (`fetch.ts:145`). ADR-0037's timing argument was made against
a 1 MB ceiling that is actually 8 MB decompressed.

## Negative results — where a defect is impossible, not merely absent

The brief asked for this distinction specifically, and it is most of the sweep.

- **`checkDnsTxt` (`verification.ts:415`)** — the brief's own example, confirmed.
  No pattern at all: it joins discrete resolver records and compares with `===`
  against a fully constructed string. A false positive requires controlling the
  TXT record at `_growth-os-verification.<host>`, which _is_ the proof being
  demanded.
- **`matchesPattern` (`parse.ts:404`)** — one backtrack position, `starTarget`
  advances monotonically, so cost is bounded by pattern × path with no
  exponential case. Read, then measured: 0.22 ms where a regex takes 3,878 ms.
- **`normalisePercentEncoding` (`:242`, `:246`)** — enumerating all 256 escapes
  shows it rewrites exactly the 66 RFC 3986 unreserved characters. **That set
  contains no URL delimiter**, so decoding cannot manufacture a `/`, `?`, `#`,
  `&` or `=`, and `String.replace` does not rescan its own output.
- **`.replace(/\+/g,'%20')` (`:231`)** — `URLSearchParams.toString()` emits a
  bare `+` only where a space was.
- **`sessionId` (`sanitise.ts:140`)** — an allow-list, `[^a-zA-Z0-9_-]`. No
  separator in any encoding survives it. Forty lines above, `toParam` is a
  deny-list that misses U+0085/2028/2029; no consequence was demonstrated for
  it, and the contrast between the two adjacent fields is the point.
- **Every anchored, bounded-quantifier pattern** — `{32}`, `{8,64}`, `{6}`,
  `{1,4}`. Flat at 10 MB. The input length never enters the cost.
- **`body.split(/\r\n|\r|\n/)` (`:152`)** — exactly RFC 9309's `EOL` production
  and byte-for-byte what Google's parser does. U+2028/2029/0085 are line breaks
  to neither, so there is no divergence to exploit. The split is sound; both
  defects are on either side of it.

## Alternatives considered

**Fix the two robots defects here.** Rejected — the brief forbids it, and
correctly: both change the crawl permission boundary and each needs its own ADR
recording the fail-closed decision. Repairing a permission boundary as a
side-effect of an audit is how the audit stops being trusted.

**Rewrite the email regex.** Rejected. It is client-side, the file already
documents it as a courtesy, and the honest fix is a length guard rather than a
new pattern.

## Files

```
docs/development-log/0018-the-regex-sweep.md   this entry
docs/development-log/README.md                 index row
```

**No source file was changed by this task.**

## Testing

No tests added — the brief scoped this to throwaway probes, all of which live in
the session scratchpad. `verify:all` re-run at the end: **882 passed / 208
skipped**, 29 boundary probes, unchanged from the start, which is the correct
result for a report-only task.

## Result

48 regexes in non-test source, classified and measured by execution.

**As a hunt for a second backtracking regex, the sweep failed and that is the
result.** Every attacker-facing regex in `net`, `crawler`, `sites`, `forms` and
`contracts` is linear or structurally independent of input length, and most are
safe by construction rather than by luck. The one superlinear pattern is
client-side, on a value its own victim types, in a file that already documents
itself as a courtesy. `findMetaToken` was the outlier, not the first of a series.

**Everything worth reporting was found by the other two questions.** Two
fail-open defects in the crawl permission boundary, one permanent URL-identity
collision, a security control documented as live with no callers, and a search
escaper that misses the escape character. None is a performance problem; none
would have been found by timing anything.

⚠️ **And the worst finding is in the code this audit was told to treat as the
standard.** The robots matcher is regex-free, has no exponential case, and meets
every claim its docstring makes — and `isAllowed` over a hostile robots.txt and
a 10,000-character path blocks the event loop for **12.5 seconds**, because
`O(rules × pattern × target)` was written down accurately and never multiplied
out. I measured it with the payload the docstring names, got 0.22 ms, and wrote
that it was fine. It took an independent probe using a different adversarial
shape to show that the number I had measured was the wrong number.

That is the lesson of this entry, and it is not the one the brief expected: **a
measurement only refutes the hypothesis you chose an input for.** Choosing that
input from the defending comment tests the author's imagination, not the
algorithm.

## Remaining work

Ranked. Each needs its own brief and its own ADR.

1. **`normaliseUrl` enforces no length cap, and `isAllowed` blocks 12.5 s
   because of it** — the two are one fix. `MAX_URL_LENGTH` already exists at
   `policy.ts:137`; applying it at `normalise.ts:137` measured 55 ms against
   12,513 ms, and bounds the two `normalise.ts` regexes as a side-effect. This
   is the only finding in the sweep with a measured denial of service behind it.
2. **Robots colon-less directives fail open** — crawl admission, fetches what a
   site owner told Google not to.
3. **Robots truncation flips Disallow to Allow** — crawl admission; the
   `truncated` flag exists and nothing fails closed on it.
4. **Query re-encoding collapses URL identity** — §5, and it keys the durable
   `site_pages` index, so it is permanent once written.
5. **`neutraliseCsvFormula` is documented as a live control and has none** —
   fix the doc now, or wire it when an export exists.
6. **`fieldTarget` has no `.max()`** and accepts a 200 KB value into stored
   config.
7. **Four `/^https?:\/\//i` copies disagree** — one normaliser, or four
   documented behaviours.
8. **The CRM LIKE escaper misses `\`** — affects `countTracesOf`, which proves
   erasure.
9. **`verification.ts` inherits an 8 MB body cap** where its comment says 1 MB.
10. The email regex, last, and probably as a length guard.

Still open from 0017: `service.ts` and `context.ts` untested (the next brief),
the 500/404 `token_absent` message, and `checkDnsTxt`'s undocumented
prefix-or-bare loosening.
