# ADR-0031 — Crawling requires proof of ownership

**Status:** Accepted
**Date:** 2026-08-17

## Context

[ADR-0029](ADR-0029-web-properties.md) §3 separated **configured** from
**verified** and deferred the proof: _"Stage 4 onwards will require `verified`."_
This is that decision.

The threat is not subtle. Without verification, Growth OS is an **arbitrary
internet scanning service that anyone can drive by signing up and typing a
domain**. Someone enters `competitor.example`, presses Start crawl, and our
infrastructure fetches five hundred pages of a site we have no relationship
with — from our addresses, with our user agent, at our legal risk and on our
bill. Repeat across accounts and it is a distributed load generator with
billing attached.

[ADR-0032](ADR-0032-crawler-network-security.md) stops the crawler reaching
_private_ infrastructure. Nothing there stops it reaching a _public_ site that
simply is not the customer's. That is this ADR's job.

## Decision

**A crawl requires `verification_state = 'verified'`, proved server-side.**

### Two methods, one token

| Method      | Proves                     | For                                                                             |
| ----------- | -------------------------- | ------------------------------------------------------------------------------- |
| `html_meta` | Control of the site itself | Anyone, including a business on Squarespace, Wix or Shopify who cannot edit DNS |
| `dns_txt`   | Control of the zone        | Anyone who owns the domain outright                                             |

`html_meta` is listed first deliberately. It proves control of **the exact thing
about to be crawled**, which is the permission being sought — and it is the only
method available to a large part of the customer base, who have a website and no
access to a nameserver.

**One token serves both.** Two tokens would mean an operator who pasted the meta
tag and then tried DNS is told their correct record is wrong — a support call
created by an implementation detail.

A verification **file** was considered and rejected: it proves exactly what the
meta tag proves, needs the same access, and adds a third code path and a third
set of support instructions for no additional assurance.

### The token is a proof, not a credential

128 bits of hex, database CHECK-enforced, identical in shape to a form's public
key. It is published in a customer's page source or in public DNS, so **every
property must hold with it fully visible**. Holding it grants nothing; what it
demonstrates is control of a place only the owner can write to.

It is therefore checked _against a specific site_, never looked up by value, and
there is no constant-time comparison — there is no secret to leak by timing, and
pretending otherwise would be theatre.

### Rotation does not un-verify

Re-issuing rotates the token and leaves a verified site verified: a business
that rotates its proof has not stopped owning its domain. What rotation buys is
that the old published string stops working, so a customer who sold a site
cannot have it re-verified by whoever bought it.

### The check uses the same network layer as the crawler

HTTP verification goes through `safeFetch`. **A second fetcher "just for
verification" would be an SSRF hole in the one endpoint whose entire job is to
take a stranger's URL** — and it is the first request the product ever makes to
a customer-supplied address.

DNS TXT does not go through `@growth-os/net`, and that is deliberate rather than
an oversight: a TXT lookup asks the configured resolver a question and opens no
connection to the host in question. Recorded here so nobody later "fixes the
inconsistency" by routing it through a fetcher, which would make it perform a
request it currently does not.

### A seeded fixture site may be verified; production has no bypass

Development seeds obviously-fictional verified sites. There is no environment
variable, header or flag that skips the check — the seed writes the same columns
any real verification writes.

## Alternatives considered

**No verification; rate-limit instead.** Rate limits bound the volume, not the
legitimacy. Crawling a competitor slowly is still crawling a competitor.

**DNS TXT only.** The strongest proof, and it excludes every customer on a
hosted platform — which is most of them.

**Trust the form-embed relationship.** A site with one of our forms on it is
evidence of _some_ relationship, and it is forgeable: the embed snippet is
public and anyone can paste it onto any page.

**Verify once, never re-check.** Domains change hands. `verification_checked_at`
exists so re-verification is possible; a schedule for it is not yet decided and
is deliberately not invented here.

## Consequences

### Positive

- The crawler is a tool a business points at its own property.
- Two methods cover both the DNS-capable and the platform-hosted customer.
- One network layer, one review.

### Negative

- Friction before the first crawl, which is the point.
- A customer who cannot edit either their site's `<head>` or their DNS cannot be
  crawled at all. Accepted: they also cannot prove ownership.
- Re-verification has no schedule. Named, not solved.

## Verification

`verification_state = 'verified'` requires `verified_at` and
`verification_method` to be non-null, enforced by CHECK — a verified row that
cannot be audited is not representable. `verification_token` is CHECK-constrained
to `^[0-9a-f]{32}$`. Both verified as refusals on a throwaway database.

## Related

- [ADR-0029](ADR-0029-web-properties.md) · [ADR-0032](ADR-0032-crawler-network-security.md) · [ADR-0025](ADR-0025-system-actors.md)
