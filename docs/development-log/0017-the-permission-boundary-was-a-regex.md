# 0017 — The permission boundary was a regex

**Date:** 2026-08-17 · **Stage:** 4

## Objective

Test `@growth-os/sites`, starting with `verification.ts` — the oldest
outstanding §2 violation in the repository, and the boundary that decides whether
a domain may be crawled.

## Initial state

`@growth-os/sites` had **zero test files** across 757 lines, 375 of them
`verification.ts`. It was reported done three times. The brief before this one
named the gap; this one closed it.

## Investigation

The brief hypothesised specific false positives in the token matcher. §1 says
measure before diagnosing, so nothing was written until the matcher had been
probed by execution: sixteen agents across four angles — placement, tag shape,
name confusion, hostile input — with every claim independently reproduced, and
the headline cases reproduced again by hand.

⚠️ The result was worse than the hypothesis. **32 distinct inputs returned a
token no browser would consider published**, and the probe found the case that
mattered most, which the brief had not.

### The finding that changed the severity

The payload `name=growth-os-verification content=<token>` contains no `<`, `>`,
`"` or `'`. Measured: `escape(payload) === payload`.

So it never has to become a tag. It only has to land inside an **existing** tag's
attribute value:

```html
<meta
  name="description"
  content="12 results for name=growth-os-verification content=0123…"
/>
```

That returned the token. **Any homepage reflecting a search term into its meta
description or Open Graph tags could verify a domain the requester does not own** —
no injection flaw, no unescaped output, no CMS access. Ordinary e-commerce and
CMS behaviour.

My first report said this "does not require an HTML-injection flaw" _before_ I had
verified it. That was reasoning ahead of measurement, and I corrected it in the
next report once the probe had actually run it. Recorded because the correction is
the lesson, not the finding.

### And it backtracked quadratically

| Input   | Regex    | Structural parse |
| ------- | -------- | ---------------- |
| 70 KB   | 88 ms    | **2 ms**         |
| 280 KB  | 1,642 ms | **6 ms**         |
| 560 KB  | 5,973 ms | **7 ms**         |
| 1.12 MB | ~20 s    | **14 ms**        |

The caller accepts 1 MB, so a page the requester chose blocked the verification
worker for about twenty seconds per attempt.

⚠️ **The robots pattern matcher in this same repository is a two-pointer scan
built deliberately to avoid exactly this.** Same stage, same knowledge, written
days apart. The discipline existed and was not applied uniformly — which is why
the next brief in the queue is a repository-wide regex sweep. One instance is a
bug; two is a pattern.

## Decisions

[ADR-0037](../decisions/ADR-0037-structural-verification-matching.md). Parse the
document; accept a token only from a real `<meta>` in `<head>` with `name` exactly
equal and `content` exactly 32 hex after trimming.

`htmlparser2` becomes a direct dependency of `@growth-os/sites`, **deliberately
not shared** with the crawler's extractor: coupling them would mean every future
change to fact extraction touches the code deciding whether crawling is permitted.

Three behaviour changes, all recorded:

1. **`<head>` only** — a tightening. Body content is far more likely to be
   user-generated.
2. **`content` trimmed** — a loosening. CMS fields pad whitespace and the token
   must still be exactly right.
3. **All published tokens considered, not the first** — a fix. Rotation means an
   operator adds the new tag before removing the old one, and the regex failed
   that page while it visibly displayed the correct proof.

## Blast radius: nil, and measured rather than assumed

- `0 verified / 0 sites` in both local databases.
- **No callers outside `packages/sites`** — no API route, no worker, no UI.

A latent defect in unreleased code, not an incident. Worth measuring before
writing the fix, because it decided what the fix was allowed to cost: no
migration, no re-verification sweep, and the `<head>` tightening breaks nothing
that exists.

## Negative results — two things checked and left alone

**`checkDnsTxt` does not have this defect.** It compares with `===` against a
constructed string over discrete resolver records. Read rather than assumed. It
does accept both the prefixed and bare token forms — an undocumented loosening,
recorded as an observation for its own brief, not touched.

**`origin.ts` is not untested.** Its coverage lives in
`packages/forms/src/public/public-path.test.ts`, where it was written before the
extraction moved the code. A pointer now says so in `origin.ts`, so the next
reader does not mistake the absence for a gap and write a second suite that will
drift from the first.

## ⚠️ A separate defect found while testing, and deliberately not fixed

A homepage returning **500 or 404 reports `token_absent`** — "we could not find
the tag" — because `safeFetch` returns `ok: true` for an HTTP error status and the
body is empty.

An operator who placed the tag correctly is sent looking for a mistake they did
not make. The honest message is "we could not read your homepage".

The test asserts the **current** behaviour with the concern named in a comment,
rather than asserting the desired behaviour and failing. Changing it is a
behaviour change to a permission boundary and belongs in its own brief (§3).

## Files

```
packages/sites/src/verification.ts                     regex → structural parse
packages/sites/src/verification.test.ts                96 cases
packages/sites/src/verification.integration.test.ts    10 cases, restricted role
packages/sites/src/origin.ts                           coverage pointer
packages/sites/package.json                            htmlparser2
docs/decisions/ADR-0037-structural-verification-matching.md
```

## Testing

**96 unit, 10 integration.** All 32 confirmed false positives assert `[]`.
Legitimate cases kept: quote styles, unquoted values, reversed attribute order,
extra attributes, self-closing, uppercase attributes and hex, mixed-case name,
newlines and tabs. Hostile: 1 MB with the tag last, 50,000 unrelated metas,
unclosed tags, 5,000-deep nesting, BOM, null byte, 90% comments, empty document.
The timing assertion runs at over 1 MB.

Integration proves what only a database can: the `verified_at` + method CHECK, a
failed attempt still recording `verification_checked_at`, `seo.site.verified`
published once, rotation invalidating the old token, rotation **not** un-verifying
a verified site, and a cross-tenant issue refused as _not found_ rather than
_forbidden_.

## Result

The crawl permission boundary is a parse. Every false positive found by probing is
now a committed test asserting refusal, so the class cannot return silently.

## Remaining work

- **`service.ts` and `context.ts` are still untested** — brief 3 in the queue.
- **The regex sweep** — brief 2. This defect's existence alongside the robots
  matcher is the argument for it.
- The 500/404 message defect above.
- `checkDnsTxt`'s undocumented prefix-or-bare loosening.
