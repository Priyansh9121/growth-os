# ADR-0028 — Browser attribution storage

**Status:** Accepted
**Date:** 2026-08-16

## Context

A visitor lands on `/emergency-plumber?utm_source=google&utm_campaign=emergency`,
reads two pages, and submits the form on `/contact`.

If nothing is stored, the acquisition records `/contact` and no campaign — and
the product's central claim, "which acquisition work produced revenue", is
answered with the page the form happened to sit on.

So something must persist across the visit. Whatever it is, it runs on a
customer's website, on their visitors' machines, under their privacy policy.

## Decision

### 1. `sessionStorage`, not a cookie, not `localStorage`

|            | Choice                            |
| ---------- | --------------------------------- |
| Mechanism  | `sessionStorage`                  |
| Lifetime   | The browser tab. Cleared on close |
| Scope      | The customer's origin only        |
| Size       | Under 1 KB                        |
| Cookie set | **None**                          |

**Why not a cookie.** A cookie is sent on every request to that origin, which
means the customer's own server and every other script on the page can see it,
and it needs a consent conversation in several jurisdictions before it may be
set at all. A form that only needs to remember the landing page for the length
of a visit does not need that.

**Why not `localStorage`.** It persists indefinitely. "How long do you keep
this?" then has no good answer, and a visitor who returns in March is still
carrying January's campaign — which is not more accurate attribution, it is
older attribution presented as current.

**Why `sessionStorage` is the right size of tool.** The problem is "the visitor
is on page three of one visit". `sessionStorage` is exactly that duration and
no longer, is origin-scoped, is never transmitted automatically, and in most
readings does not require prior consent because it is strictly necessary for
the functionality the visitor is asking for.

The cost, stated: attribution does not survive a closed tab. A visitor who
returns tomorrow through a direct visit is recorded as direct — which is the
truth about _that_ visit, and preferable to asserting a campaign from a week
ago produced it.

### 2. Exactly what is stored

```jsonc
{
  "v": 1,
  "sid": "…", // opaque random id, generated in-browser, no identity
  "firstSeenAt": "…", // ISO timestamp
  "landingPath": "/emergency-plumber", // PATH ONLY — query string discarded
  "referrerOrigin": "https://www.google.com", // ORIGIN ONLY
  "utm": { "source": "google", "medium": "cpc", "campaign": "emergency" },
  "gclid": "…",
  "fbclid": "…",
}
```

### 3. Exactly what is NOT stored, and never collected

Browsing history beyond the landing page · page content · other forms' fields ·
keystrokes · mouse movement · session replay · scroll · clicks · cookies of any
kind · canvas/font/WebGL fingerprints · IP (the browser never sees its own) ·
any name, email, phone or message · **the landing page's query string**, beyond
the specific attribution parameters named above.

`landingPath` is a path and `referrerOrigin` is an origin **because query
strings routinely carry PII** — a booking confirmation link, an email tracking
parameter, a password reset token someone pasted. Truncating at the server is
too late; the script truncates before it stores.

### 4. `sid` is a correlation id, not an identity

Random per tab, meaningless outside it, never linked to a person, never sent
anywhere except with a submission from the same tab. It exists so first touch
and submission touch can be joined within one visit. It is not a user id and
there is no table mapping it to one.

### 5. Lead submission never depends on tracking

**The form works with attribution storage completely unavailable** — blocked,
disabled, private mode, consent declined, storage full. The acquisition is then
recorded with whatever the submission itself carries, and `unknown` where it
carries nothing.

This is the load-bearing rule. A business must never lose an enquiry because a
visitor declined marketing cookies, and the product must never be tempted to
make attribution a precondition for capture.

### 6. Consent

No claim is made that one global rule applies. The script operates in its
privacy-minimising mode **by default and always** — no cookies, tab-lifetime
storage, no cross-site anything — which is the mode most consent regimes treat
as strictly necessary.

For deployments that must gate even this, the script exposes
`window.GrowthOS.disableAttribution()`, callable from a consent manager before
or after load. Documented, not automated: we do not know the customer's
jurisdiction and will not guess.

## Alternatives considered

**First-party cookie, 30–90 days.** The industry default, and the reason
attribution windows exist. Rejected for V1: it is the highest-consent-burden
option, it is visible to every script on the page, and multi-visit attribution
is a Stage 16 problem that deserves a deliberate model rather than a cookie set
early and reasoned about later.

**Server-side session via a first-party endpoint.** Better privacy properties
in principle; requires the customer to route a path on their own domain to us,
which most cannot do.

**No storage; read the referrer at submission.** Loses first touch entirely —
by the time the visitor reaches `/contact`, the referrer is the customer's own
site.

**Full analytics (pageviews, events, replay).** Not the product. Growth OS
measures _acquisition_, and a session replay tool that happens to also capture
leads would be a different, much harder promise.

## Consequences

### Positive

- No cookies, so no cookie banner is required by us.
- Attribution data cannot outlive the visit.
- No PII in browser storage, by construction rather than by filtering.
- Capture is never blocked by tracking being unavailable.

### Negative

- **No cross-visit attribution.** A visitor who arrives from a campaign and
  converts three days later is recorded as whatever their converting visit was.
  Named as a limitation, not smoothed over — and revisited in Stage 16 with a
  proper multi-touch model rather than by quietly extending the storage.
- Tab-per-visit means two tabs are two sessions.

## Revisit when

- Stage 16 designs multi-touch attribution — that is the right moment to decide
  whether a longer-lived identifier is worth its consent cost.
- A customer needs view-through or cross-device attribution.

## Related

- [ADR-0012](ADR-0012-provenance-model.md) · [ADR-0020](ADR-0020-privacy-erasure.md)
- [security/attribution-privacy.md](../security/attribution-privacy.md)
