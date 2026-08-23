# ADR-0068 — The page fetch returns parsed state

**Status:** Accepted
**Date:** 2026-08-23

## Context

`extractLinks` needs an HTML document. `fetchPage` had one — it reads the
response body to measure `contentLength` and `bytes` — and then discarded it,
returning a `PageObservation` with no document field. So the extractor could
not be called from anywhere: the only code holding a page's HTML threw it away
before returning.

Two constraints bound the fix.

**`PageObservation` must stay spreadable.** Its own doc comment says it is
_"shaped to `crawl_pages`'s response columns, so `markFetched` can spread it
without a translation layer inventing a second vocabulary"_, and `markFetched`
does exactly that (`...input.observation`). Any field added to it must be a
column. Links are rows in a different table, so they cannot live there — the
call site already has to strip `bytes` as an exception, and a second exception
would erode the property to nothing.

**The raw body should not spread.** Not because an ADR forbids it — the "no raw
HTML leaves this module" note in `links/extract.ts:15` cites ADR-0034, which is
about page identity versus page facts and never mentions HTML, so that citation
is wrong — but because the two sibling fetch modules already establish the
narrower shape, and diverging here would make the crawler's three fetch paths
stop resembling each other.

## Decision

**`fetchPage` returns `PageState { observation, links }`, extracting links
itself when given the site's `CrawlScope`.**

This is the shape the package already uses twice:

| module             | returns        | facts                      | parsed     |
| ------------------ | -------------- | -------------------------- | ---------- |
| `robots/fetch.ts`  | `RobotsState`  | `outcome`, `detail`, `url` | `rules`    |
| `sitemap/fetch.ts` | `SitemapState` | `outcome`, `detail`, `url` | `document` |
| `pages/fetch.ts`   | `PageState`    | `observation`              | `links`    |

Each decodes its own body with `body.toString('utf8')`, hands it to its own
parser, and returns the parsed result beside the response facts. The bytes
never leave any of the three.

`observation` and `links` are **siblings, not nested**, which is what preserves
the spread into `crawl_pages`.

Extraction is **opt-in**: no `scope`, no parsing. The scope is the site's, not
the page's — whether a link is internal is a property of the site being
crawled, which is the same argument `extractLinks` makes at its own signature.

Extraction is gated on the media type (`text/html`, `application/xhtml+xml`).
The content type gates **parsing, not fetching**: `fetchPage` still records
that a URL returned a PDF, because refusing on the header would lose the fact
rather than record it.

The base URL for resolution is the **final** URL after redirects, not the
requested one. A document served from `/moved/here` states relative links
relative to there.

## Alternatives considered

**A. Return the raw body and let `runCrawl` call the extractor.**
Rejected. It puts a document parser call in the module whose stated
responsibility is _"compose three tested subsystems… and add no rules of its
own"_, and it makes `pages/fetch.ts` the only fetch module in the package that
hands its body out rather than parsing it. It also spreads the decoding
decision: `robots` and `sitemap` decide `utf8` internally, and a third place
deciding it differently is how two modules end up disagreeing about what a byte
means.

**B. Add `links` to `PageObservation`.**
Rejected. It breaks the spread that `markFetched` depends on — the insert would
carry a `links` key against a column that does not exist. The call site would
need `{ ...observation, bytes: undefined, links: undefined }`, and the next
field added would need a third exception.

**C. Pass a callback so the body is handed to the caller without being
returned.** Rejected as the same coupling as A with worse ergonomics: the
caller still supplies the parsing logic, and the control flow becomes harder to
read for no gain in what is protected.

**D. Keep `fetchPage` returning `PageObservation` and add a second exported
function that fetches and extracts.** Rejected. Two functions that both fetch a
page is two code paths through the SSRF pipeline, and §5 is explicit that a
second path is exactly what must not be added.

## Consequences

- `fetchPage`'s return type changes. Its one production caller and its unit
  tests destructure `{ observation }`; nothing else consumed it.
- A caller that wants links must supply the site scope, which it already holds
  (`EnqueueEnvironment.scope`).
- Raw HTML still never escapes a module, now for all three fetch paths.
- `PageState.links` is `readonly ExtractedLink[]` and empty covers four cases —
  no scope, not HTML, fetch failed, genuinely no links. A `null` would add a
  state no caller answers differently.

## Known limitation, stated rather than hidden

`toString('utf8')` is the package's existing decoding answer and this follows
it. There is no charset sniffing anywhere in the crawler, so a non-UTF-8 page
yields U+FFFD for bytes that do not decode. `href`s are effectively always
ASCII, so link targets are unaffected; anchor text on a Latin-1 page can come
back with replacement characters. That is a limitation to fix across
`robots/fetch.ts`, `sitemap/fetch.ts` and this module together, not to fork
here.
