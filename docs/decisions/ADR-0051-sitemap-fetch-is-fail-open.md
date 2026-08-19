# ADR-0051 — A sitemap that cannot be read fails OPEN, which is the opposite of robots.txt

**Status:** Accepted
**Date:** 2026-08-19

## Context

ADR-0035 decided that an unreadable `robots.txt` disallows the entire site. That
reasoning is written down, it is good, and applying it here by analogy would be
exactly wrong. A new parser arriving next to an existing one is the moment its
precedent gets copied without re-deriving whether it holds.

## Decision — every failure leaves the site crawlable

`SitemapState.siteDisallowed` is `false` on every branch, and typed as the
literal `false` so the compiler enforces it rather than a reviewer.

### Why the robots reasoning does not transfer

**A sitemap grants nothing.** It is the site's own list of pages — an
optimisation over discovering them by following links. `robots.txt` is a
permission artefact; failing to read it means we do not know what we may do.
Failing to read a sitemap means we do not have a shortcut.

The robots argument turns on that: _"we could not read robots.txt" is not
"robots.txt permits this"_. Its sitemap equivalent would be "we could not read
the sitemap is not the sitemap permits this" — which is not a sentence, because
a sitemap never permitted anything.

And most sites do not publish one at all. Treating absence the way robots'
absence is treated would make the majority of the web uncrawlable, on the
strength of a file that was never required.

| status / event | robots.txt      | sitemap.xml   |
| -------------- | --------------- | ------------- |
| 2xx            | rules apply     | `fetched`     |
| 4xx            | unrestricted    | `absent`      |
| **401 / 403**  | **fail-CLOSED** | **`absent`**  |
| 5xx            | fail-closed     | `unavailable` |
| network / SSRF | fail-closed     | `error`       |

### ⚠️ 401 and 403 diverge deliberately

ADR-0035 fails closed on them: a site that authenticates its _rules_ is telling
us we are not an audience for them, and proceeding unrestricted against a
deliberately walled-off file is the least defensible reading available.

A site that authenticates its _sitemap_ is telling us nothing about permission —
only that this particular file is not public. Its `robots.txt` is still the
place permission lives, and it is fetched separately.

### `not_a_sitemap` is a separate outcome from `absent`

A 200 carrying an HTML 404 page is extremely common. Reporting it as `absent`
would be a small lie an operator cannot debug — "we could not find your sitemap"
when the server said it found something. The outcome distinguishes "the server
says there is nothing here" from "the server returned something that is not a
sitemap".

## Decision 2 — gzip is decompressed here, bounded, and that is not a second network path

`safeFetch` decompresses on **`content-encoding`**, which is what a server sets
when it compresses a response in transit. `sitemap.xml.gz` is a different thing:
the _file_ is compressed, served with `content-type: application/gzip` and
usually **no** `content-encoding` at all. Those bytes arrive compressed and
never reach `safeFetch`'s decompressed tier.

Verified before deciding: `safeFetch` branches solely on the
`content-encoding` header (`fetch.ts:418`).

So this module inflates them, detecting the `1f 8b` magic number rather than
trusting a content type any server can mislabel.

### ⚠️ The bound here is the only one that applies

`gunzipSync(body, { maxOutputLength })` aborts the inflate instead of allocating
first. Measured: it throws `ERR_BUFFER_TOO_LARGE`, and a 64 MB payload
compresses to well under the wire cap — so without this bound the wire cap would
be no bound at all for `.gz` sitemaps.

**This is not a fast path around §5.** The request is complete before it runs.
URL admission, address classification, the pinned DNS resolution, redirect
handling and both transport tiers have all already applied to the bytes in hand.
This inflates a body we hold, with its own explicit ceiling. `node:zlib` opens
no socket and is not among the imports the boundary probes forbid the crawler
(`node:http`, `node:https`, `node:net`, `node:dns`) — checked, not assumed.

## Alternatives considered

**Fail closed on 5xx, matching robots.** Rejected above: it withdraws permission
a sitemap never granted, and it would stop a crawl because an optional file was
briefly unavailable.

**Treat 401/403 as fail-closed, matching robots.** The closest call here, since
the shapes look identical. Rejected because the robots argument is specifically
about _rules_ being walled off. A private sitemap is a private file.

**Refuse `.gz` bodies and support only `content-encoding`.** Simpler, no `zlib`,
no second decompression bound. Rejected: `sitemap.xml.gz` is what large sites
actually publish, and refusing it would mean silently reading no sitemap for
exactly the sites that most need one.

**Decompress inside `@growth-os/net`, sniffing the magic number there.**
Tempting, and wrong: it would make `safeFetch` decompress bodies the server did
not say were compressed, changing behaviour for every caller — the crawler, page
fetches, verification — to serve one format's convention. §5 forbids adding a
hop; this would have changed one for everybody.

## Consequences

### Positive

- A missing, broken or private sitemap costs a shortcut and nothing else.
- The asymmetry with robots is visible in the type (`siteDisallowed: false`),
  in the header comment, and in a property test over every branch — not left to
  a reader noticing.
- `.gz` sitemaps work, with a bound that is measured rather than inherited.

### Negative

- **Two decompression paths now exist** for the same format, in different
  packages, triggered by different signals. Justified above, and it is still two
  places a reader must know about.
- **`siteDisallowed: false` is dead weight in the type.** It exists to make the
  contrast with `RobotsState` legible; a reader could reasonably call it noise.
- **A 200 serving an HTML error page is `not_a_sitemap`, not an error.** That is
  honest but it means a genuinely misconfigured server and a site with no
  sitemap are reported differently for a reason an operator may not care about.

## Verification

**20 tests** in `packages/crawler/src/sitemap/fetch.test.ts`.

The strong property is asserted directly: a loop over 2xx, non-XML 200, 404,
403, 500 and a transport failure, checking `siteDisallowed` is false on every
one — so a future branch that sets it fails the suite rather than the review.

The SSRF case uses `ForbiddenTransport`, which throws if dialled, proving no
socket was opened rather than that an error came back (§6).

The gzip bomb test asserts the compressed payload is **under** the wire cap
before asserting the outcome, so it proves the second bound is what caught it.

`verify:all` exit 0 at **1,206 passed / 230 skipped (1,436)**, against 1,155 /
230 (1,385) at `ec73aad`. 29 boundary probes.
