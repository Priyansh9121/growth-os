# Attribution Privacy

**Status:** Implemented (Stage 3)
**Last verified:** 2026-08-16

What Growth OS captures about a website visitor, what it deliberately does not,
and where each rule is enforced.

---

## 1. The shape of the promise

Growth OS measures **acquisition**. It answers "which work produced this
enquiry?" and nothing else. It is not analytics, and it is not session replay.

That is a product boundary, not a configuration option: there is no pageview
beacon, no event API, and the tracking script makes **no network request at
all**. It writes one key to `sessionStorage`; the form reads it at submission.

## 2. Exactly what is captured

| Field                                    | Example                  | Why                                                                                                           |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `sid`                                    | `a3f1…`                  | Correlates first touch with submission **inside one tab**. Random, meaningless elsewhere, linked to no person |
| `firstSeenAt`                            | ISO timestamp            | When the visit began                                                                                          |
| `landingPath`                            | `/emergency-plumber`     | **Path only**                                                                                                 |
| `referrerOrigin`                         | `https://www.google.com` | **Origin only**                                                                                               |
| `utmSource/Medium/Campaign/Term/Content` | `google`, `cpc`, …       | The five standard campaign parameters                                                                         |
| `gclid`, `fbclid`                        | opaque token             | Ad-platform click identifiers                                                                                 |

Total under 1 KB.

## 3. Exactly what is NOT captured

Browsing history beyond the landing page · page content · other forms' fields ·
keystrokes · mouse movement · scroll · clicks · session replay · cookies of any
kind · canvas, font or WebGL fingerprints · IP address (the browser never sees
its own) · any name, email, phone or message · **the landing page's query
string** beyond the parameters named above.

### ⚠️ Why the path-and-origin truncation is a PII control

Query strings routinely carry personal data: a booking confirmation link, an
email tracking parameter, a password reset token someone pasted into a browser.

A full landing URL stored on an acquisition would be **PII in a column nobody
classifies as PII** — outside erasure's model of where personal data lives, and
invisible to retention policy.

So it is truncated three times, at decreasing levels of trust:

1. **In the browser**, by the tracking script, before it is stored.
2. **In the browser**, by the form renderer, when it derives attribution from
   the hosted form's own URL.
3. **On the server**, by `sanitiseContext`, because a submission can be posted
   by anything — `curl`, a custom integration, a modified page.

The third is not redundant. The first two are conveniences; only the server's is
a control.

### The search query, specifically

A Google referrer occasionally still carries `?q=`. It is discarded at step 1,
in the browser, and would be discarded again at step 3.

Capturing it opportunistically would make the keyword report a **biased 2%
sample presented as data**. `search_query` comes from Search Console and nothing
else ([ADR-0012](../decisions/ADR-0012-provenance-model.md)).

## 4. Storage

| Property                  | Choice                                |
| ------------------------- | ------------------------------------- |
| Mechanism                 | `sessionStorage`                      |
| Lifetime                  | **The browser tab.** Cleared on close |
| Scope                     | The customer's origin only            |
| Transmitted automatically | **Never** — unlike a cookie           |
| Cookies set               | **None**                              |

**Why not a cookie.** A cookie is sent on every request to that origin, so the
customer's own server and every other script on the page can read it — and it
needs a consent conversation in several jurisdictions before it may be set at
all. Remembering a landing page for the length of one visit does not need that.

**Why not `localStorage`.** It persists indefinitely, so "how long do you keep
this?" has no good answer, and a visitor returning in March still carries
January's campaign — which is not better attribution, it is older attribution
presented as current.

## 5. Consent

No claim is made that one global rule applies worldwide.

The script operates in its **privacy-minimising mode by default and always** —
no cookies, tab-lifetime storage, nothing cross-site — which is the mode most
consent regimes treat as strictly necessary for functionality the visitor is
asking for.

For deployments that must gate even this:

```js
window.GrowthOS.disableAttribution();
```

Callable from a consent manager before or after load. Documented rather than
automated: we do not know the customer's jurisdiction and will not guess one.

### ⚠️ The load-bearing rule

**Lead submission never depends on tracking.**

The form works with attribution storage completely unavailable — blocked,
disabled, private mode, quota exhausted, consent declined, or corrupt. The
acquisition is then recorded with whatever the submission itself carries, and
`unknown` where it carries nothing.

A business must never lose an enquiry because a visitor declined marketing
tracking, and the product must never be tempted to make attribution a
precondition for capture. Two browser tests assert it: one blocks
`sessionStorage` entirely, one corrupts its contents.

## 6. Erasure

Attribution data on an acquisition is governed by
[data-lifecycle.md](data-lifecycle.md). On erasure:

| Cleared                                                                              | Kept                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `gclid`, `fbclid` — pseudonymous identifiers the ad platform can resolve to a person | `source_type`, `source_platform`, `confidence` |
| `referrer_origin`, `channel_detail`, `metadata`                                      | The UTM set, `landing_path`                    |

Aggregate attribution survives an erasure; the identifiers that point back to an
individual do not.

Browser storage needs no erasure path: it is tab-scoped, holds no PII, and is
gone when the tab closes.

## 7. Known limitation

**No cross-visit attribution.** A visitor who arrives from a campaign and
converts three days later is recorded as whatever their converting visit was.

That is the cost of tab-lifetime storage and it is named rather than smoothed
over. Stage 16 designs multi-touch attribution deliberately — which is the right
moment to weigh a longer-lived identifier against its consent cost, rather than
quietly extending the storage now.

## Related

- [ADR-0028](../decisions/ADR-0028-attribution-storage.md) · [ADR-0012](../decisions/ADR-0012-provenance-model.md)
- [architecture/lead-capture-architecture.md](../architecture/lead-capture-architecture.md)
- [data-lifecycle.md](data-lifecycle.md)
