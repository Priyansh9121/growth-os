# ADR-0033 — One definition of "the same page"

**Status:** Accepted
**Date:** 2026-08-17

## Context

Five parts of a crawler independently form an opinion about a URL:

- the frontier, deciding whether a URL has been seen
- an anchor `href`, resolved against the page it was found on
- a `<link rel="canonical">`
- a redirect `Location`
- a sitemap `<loc>`

If each normalises differently, the crawler fetches `/about` and `/about/` as
two pages, `/pricing` and `/pricing?utm_source=google` as two more, and every
`#section` anchor on a documentation page as its own resource.

The failure is worse than the wasted requests. A crawl reporting **428 pages for
a 214-page site** makes every count downstream wrong — pages missing a title,
orphan pages, the change diff between two crawls — with no way to tell from the
output which half is real.

## Decision

**One `normaliseUrl`, in `@growth-os/crawler/src/urls`. Nothing normalises
inline.**

### The transformations, and why each

| Rule                                                       | Reason                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Lowercase scheme and host; punycode IDNs                   | The parser does it; hosts are case-insensitive                                            |
| Strip a root-zone trailing dot                             | `example.com.` and `example.com` are one site and two strings                             |
| Drop a default port                                        | `:443` on https is the same resource                                                      |
| Resolve `.` and `..`; canonicalise percent-encoding        | `%2F` and `%2f` are one byte; `%7E` and `~` are one character                             |
| **Drop the fragment, always**                              | `/page#one` and `/page#two` are ONE HTTP resource — the fragment never leaves the browser |
| Strip tracking and session parameters                      | See below                                                                                 |
| Sort remaining parameters by name, preserving repeat order | `?a=1&b=2` and `?b=2&a=1` are one request to every server ever written                    |

### ⚠️ What is deliberately NOT done

**Query strings are not stripped wholesale.** It is tempting — it collapses an
infinite query space instantly — and it is wrong: `?product=1234` is a different
product. Query explosion is bounded by the frontier's page and depth caps, not
by pretending pages are the same.

**Trailing slashes are not folded by default.** `/a` and `/a/` _are_ different
URLs and servers routinely serve different content. A site that canonicalises
one to the other emits a `301`, which the crawler follows and records — the
honest way to learn it. The fold exists as an option for a site that needs it.

### Tracking parameters are stripped for identity only

`utm_*`, `gclid`, `fbclid`, `msclkid` and the rest name the same page. Session
parameters (`PHPSESSID`, `JSESSIONID`) are stripped for a sharper reason: they
mint a new URL per visitor, so keeping them would let one template consume an
entire crawl budget.

⚠️ **The same parameters are load-bearing elsewhere.** Stage 3's attribution
reads exactly these to decide where a lead came from
([ADR-0028](ADR-0028-attribution-storage.md)). Discarding them here is a
statement about _page identity_, not about their value.

### Three questions, three functions

Conflating them is how a URL ends up fetched because it normalised cleanly:

| Question                     | Where                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Is this the same page?       | `normaliseUrl` — identity                                                                    |
| May we fetch it at all?      | `admitUrl` in `@growth-os/net` — security ([ADR-0032](ADR-0032-crawler-network-security.md)) |
| Does it belong to this site? | `classifyScope` — product                                                                    |

### Scope reports a reason, not a boolean

`in_scope` · `scheme_upgrade` · `other_subdomain` · `external`. "412 external
links" and "38 links to a subdomain you have not verified" are separately
useful; "450 links we did not follow" is not.

The `http → https` upgrade on the **same host** is the one relaxation, because
almost every site redirects, and without it the first fetch of an `http://` site
leaves scope on hop one.

Sibling subdomains report `external`. Recognising them needs the registrable
domain, which needs the Public Suffix List — a downloaded file that is wrong the
moment it goes stale, answering a question with no safe wrong answer on
`wordpress.com` or `github.io`, where every sibling is a different customer. The
code claims only a parent/child relationship, which it can prove.

## Alternatives considered

**A library (`normalize-url`, `urijs`).** Sensible defaults for humans, wrong
for a crawler: most fold trailing slashes and strip `www` by default, both of
which change what is fetched. The rules here are a product decision, not a
formatting one.

**Normalise at the point of use.** How it goes wrong in the first place.

**Aggressive canonicalisation (drop `index.html`, force lowercase paths).**
Paths are case-sensitive on most servers, and `/index.html` may differ from `/`.
Both risk merging two real pages, which loses data — where failing to merge only
costs a request.

## Consequences

### Positive

- Page counts mean something.
- Change detection compares like with like across crawls.
- Identity is normalised once, at the boundary, and stored.

### Negative

- `/a` and `/a/` cost two fetches on sites that serve both without redirecting.
- The tracking-parameter list needs occasional maintenance as ad platforms add
  identifiers. A missed one costs a duplicate, not a wrong answer.

## Verification

**117 tests.** Same-page-different-spelling tables, genuinely-different-page
tables, every stripped parameter individually, repeat-parameter ordering,
relative resolution, non-page schemes, and idempotence — normalising twice
changes nothing.

## Related

- [ADR-0034](ADR-0034-crawl-storage-model.md) — `normalised_url` is the durable key
- [ADR-0028](ADR-0028-attribution-storage.md) · [ADR-0032](ADR-0032-crawler-network-security.md)
