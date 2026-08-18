# ADR-0040 — Three ways the robots parser failed open, and why fixing them is not "refuse more"

**Status:** Accepted
**Date:** 2026-08-18

## Context

`parse.ts` opens with a claim: _"Every ambiguity below resolves toward not
fetching."_ Dev log 0018's audit found two places where it did the opposite.
Measuring them found a third.

All three share a shape. None is a bug in the matcher, which ADR-0037 through
ADR-0039 spent three briefs hardening. Each is **the parser deciding, in
silence, that something it could not read was something it need not obey.**

### Defect 1 — a directive without a colon was ignored

`line.indexOf(':')` treated the colon as the only field/value separator.
Measured through the module:

| robots.txt                           | groups | `/admin/customers`              |
| ------------------------------------ | -----: | ------------------------------- |
| `User-agent: *` / `Disallow: /admin` |      1 | refused, `longest_match`        |
| `User-agent: *` / `Disallow /admin`  |      1 | **FETCHED**, `no_rule_matched`  |
| `User-agent *` / `Disallow /admin`   |  **0** | **FETCHED**, `no_group_matched` |
| `User-agent\t*` / `Disallow\t/admin` |  **0** | **FETCHED**                     |

The `User-agent` case is the worse one: **zero groups**, so every rule in the
file belonged to nothing and the entire file evaluated as `no_group_matched` —
silently discarded in full.

### Defect 2 — the byte cap fabricated a rule

`body.slice(0, maxBytes)` is a character offset applied to text with line
structure, so the last line it leaves is half a directive. Reproduced with the
cut landing inside the final value:

```
…Disallow: /private\nAllow: /private-public-page
                                  ↑ cut
```

| rules              | parsed                                              |
| ------------------ | --------------------------------------------------- |
| untruncated        | `Disallow: /private`, `Allow: /private-public-page` |
| truncated (before) | `Disallow: /private`, **`Allow: /private`**         |

The stump ties `Disallow: /private` on effective length, **Allow wins the
tie**, and `/private` and `/private/secret-invoices` both become fetchable. The
site never wrote that rule.

### ⚠️ Defect 3 — repeated groups were not combined, found while measuring defect 1

Not in dev log 0018 and not in the brief. A file with **a colon on every line**:

```
User-agent: *
Allow: /
User-agent: *          ← same agent, second group
Disallow: /admin
```

`selectGroup` returned the **first** wildcard group, so `Disallow: /admin` was
discarded and `/admin/customers` was **FETCHED**. Swapping the two rules refuses
it. **The verdict depended on which duplicate the file happened to list first**,
which is not a property a permission boundary may have. RFC 9309 §2.2.1 requires
records of groups with the same user-agent to be combined.

It matters here because **fixing defect 1 widens exposure to it**: recognising
colon-less `User-agent` lines creates more groups, and therefore more duplicates.
Repeated groups are ordinary in generated files — a plugin appends a block, a
theme appends another, and both write `User-agent: *`.

## ⚠️ The brief's premise was wrong, and it could not have been right

The brief stated: _"Both make the crawler fetch strictly less. That direction is
safe"_, and required _"a property test proves neither change can permit a URL
that was previously refused."_

**Measured, that property is false for every one of the three fixes, and no
correct implementation can make it true.** Differential over 10,368 generated
files × 6 paths = 62,208 verdicts, shipped module against the previous one:

|                                       |  verdicts |
| ------------------------------------- | --------: |
| unchanged                             |    53,408 |
| **now refused** (allowed → refused)   | **7,758** |
| **now permitted** (refused → allowed) | **1,042** |

Every one of the 1,042 is the same shape, attributed by measurement:

| cause                                                        | verdicts |
| ------------------------------------------------------------ | -------: |
| a colon-less `User-agent` line naming us becomes visible     |  **776** |
| repeated groups merge and the merged set contains an `Allow` |  **266** |

The archetype:

```
User-agent: *
Disallow: /
User-agent GrowthOSBot     ← invisible to the old parser
Allow: /admin
```

Before, the colon-less line was skipped, so `Allow: /admin` fell into the
wildcard group and `Disallow: /` refused everything. Read correctly, the site
has written **a group that names us**, and RFC 9309 says the most specific group
applies _and only that one_ — a rule this file already implements and already
tests. So the wildcard's `Disallow: /` no longer applies to us.

**Reading a robots.txt correctly can reveal a group more permissive than the one
we were wrongly applying.** "Refuses more" is therefore not available as a
correctness property, and chasing it would mean deliberately ignoring a group
the site owner wrote for us. The same holds for defect 2 in the other direction:
a truncated `Disallow: /private-public-page` becomes `Disallow: /private` and
**over**-refuses, so declining to fabricate it permits more.

### What is asserted instead

Three properties that are true, strong, and all fail against the old parser:

1. **No cut, at any offset, ever invents a rule.** For five files and every
   truncation point, the rules parsed are a **subset** of the rules the
   untruncated file produces. A fabricated stump is exactly a rule outside that
   set.
2. **The verdict does not depend on which duplicate group comes first.**
   Permuting duplicates changes nothing.
3. **A legitimate file is untouched.** Over the 432 corpus files that use a colon
   on every line and repeat no agent — 2,592 verdicts — **every verdict is
   identical** to before. Plus a committed table of real-world WordPress,
   multi-agent, empty-`Disallow` and precedence cases.

## Decision

### 1. The colon wins wherever it appears; whitespace is a fallback for two-token lines

```
colon present anywhere  → split on the first colon        (unchanged)
no colon, two tokens    → split on the first whitespace   (new)
no colon, three or more → the line is ignored             (unchanged)
```

⚠️ **The colon must keep priority.** Taking the first whitespace instead would
turn `Disallow : /admin` — which parses correctly today — into the value
`: /admin`, matching nothing: a fail-open introduced by the fail-open fix.

⚠️ **Whitespace separates only when the line is exactly two tokens.** Otherwise
`Disallow the admin area please` becomes a rule and so does any sentence someone
forgot to comment out. Google's parser carries the same restriction. A value
that legitimately contains a space is therefore never split — the line is
ignored, exactly as before.

**Which standard wins, stated once.** RFC 9309 requires the colon, so the old
behaviour was conformant. Where the RFC and Google's parser disagree, this file
now follows **whichever refuses more**, because a site owner writes robots.txt
to be obeyed and tests it against Google. `maxBytes` is already justified in-file
as Google's ceiling, _"the least surprising choice for a site owner who tested
against Google"_; this is that argument applied to a case where the surprise
would be us fetching their admin panel.

### 2. A truncated body discards its final partial line

The cut is a character offset; a partial line is not a directive. Everything
after the last line break is dropped, so every surviving rule is one the site
wrote in full.

⚠️ **This is not rejecting the file.** ADR-0035 is explicit: _"A robots.txt
larger than the 512 KB parse cap is truncated, not rejected — the rules we read
still apply. Truncation is not permission."_ That still holds. What changes is
that we no longer invent the one rule we did not finish reading.

No line break inside the cap means nothing was read to the end of a line, so
there is nothing trustworthy to keep and the result is no rules.

### 3. `selectGroup` combines every group naming the winning token

Specific token still beats `*`, and the wildcard is still not applied on top of a
specific group. What changes is that **all** groups naming the winner are
combined rather than the first one being returned.

⚠️ **Crawl-delay merges to the maximum, not the first.** Duplicated groups
declaring different delays is an ambiguity, and ADR-0035 makes the direction
unambiguous: `Crawl-delay` may only ever slow us down. Taking whichever came
first would let file order decide how hard we hit someone's server.

The returned group's `agents` is the winning token alone, not the union of the
agent lists it came from — it describes whose rules these are, and a merged view
of several `User-agent` lines would be a fact the file does not contain (§5).

## Alternatives considered

**Accept whitespace for `Allow`/`Disallow` but not `User-agent`.** Rejected. It
leaves `User-agent *` producing zero groups — the worst outcome available, since
the whole file is discarded — and it is not monotone either, because a
recognised colon-less `Allow` permits more.

**Accept whitespace only for `Disallow`, to preserve monotonicity.** Rejected. It
buys the property by deliberately misreading the file: honouring `Disallow /x`
while ignoring `Allow /x/y` states something the site never said, and it still
leaves `User-agent *` discarding the file.

**Split on whitespace before the colon.** Rejected by measurement:
`Disallow : /admin` regresses to a rule matching nothing.

**Keep the truncated stump when it is a `Disallow` and drop it when it is an
`Allow`.** Monotone, and rejected outright. It reports `Disallow: /private` as
the deciding rule when the site wrote `Disallow: /private-public-page` — a §5
violation, a fact that is false, shown to an operator asking why a page was
skipped.

**Fail closed on `truncated` entirely.** Rejected: ADR-0035 decided this and
nothing here supersedes it.

**Merge repeated groups at parse time instead of in `selectGroup`.** Rejected as
lossy — `rules.groups` is the file's structure as written, and flattening it
there would make `parseRobotsTxt` report something the file does not contain.
Merging belongs where the question "which rules apply to me?" is asked.

**Leave defect 3 for its own brief** (§3 scope control). Put to the author with
the measurement, because fixing defect 1 alone ships 1,386 refused→allowed
verdicts through defect 3's path. Decision: fix all three together.

## Consequences

### Positive

- The three known fail-open paths in the crawl permission boundary are closed.
  7,758 verdicts move from fetch to refuse.
- A well-formed file's verdict no longer depends on the order of its duplicate
  groups.
- Every rule the parser reports is a rule the site wrote in full, which is what
  makes `rule` in a `RobotsVerdict` a fact rather than an artefact (§5).

### Negative

- 1,042 verdicts move from refuse to fetch. All are cases where the old parser
  was applying the wrong group; each is pinned by a committed test so it cannot
  be mistaken for a regression later.
- `parseRobotsTxt` and `selectGroup` are both slightly more expensive:
  `selectGroup` now scans all groups twice and allocates a merged rule list. The
  step budget in ADR-0039 bounds evaluation regardless, and the suite's timing
  assertions still pass.
- A colon-less line whose value legitimately contains whitespace is still
  ignored. It is the same behaviour as before and the same as Google's, but it
  is a case where a site owner's intent is visible to a human and not to us.

## Verification

**22 new tests** in `packages/crawler/src/robots/parse.test.ts`. Suite:
**925 passed / 208 skipped (1133)**, against 903 / 208 before. 29 boundary
probes.

Every defect has a test that was **observed red before the fix and green after** —
10 failing on the unmodified parser, covering all three defects.

⚠️ **One existing assertion changed and it is the fix landing.**
`normalise.test.ts` pinned the hostile corpus at **255** rules. It is now 254:
the 255th was never a rule, it was the stump the byte cap fabricated. ADR-0038
named it as the truncation defect awaiting its own brief and wrote that the
verdict was deliberately unasserted because of it; this is that brief, and the
comment is updated to say the refusal now comes from the hostile rules
themselves.

## Related

- [ADR-0035](ADR-0035-robots-and-politeness.md) — fail closed on unreadable robots.txt
- [ADR-0038](ADR-0038-url-length-ceiling.md) — named the truncation defect it could not fix
- [ADR-0039](ADR-0039-robots-matcher-step-budget.md) — the step budget, and the same non-monotone lesson
- [dev log 0018](../development-log/0018-the-regex-sweep.md) — where defects 1 and 2 were found
- [dev log 0021](../development-log/0021-the-fail-open-defects.md) — this work
