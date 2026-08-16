# ADR-0029 — `sites`: one shared web-property model

**Status:** Accepted
**Date:** 2026-08-16

## Context

Three capabilities need to know "which website does this workspace own?", and
they arrive in three different stages:

| Need                 | Stage | Wants                                               |
| -------------------- | ----- | --------------------------------------------------- |
| Form allowed origins | 3     | Which origins may embed this workspace's forms      |
| Attribution          | 3     | Which origin a submission's landing page belongs to |
| Crawler              | 4     | Which origin to crawl, and proof we may             |
| Search Console       | 6     | Which property to connect                           |

Built ad hoc, that becomes an origin string on a form, a different origin string
on a crawl config, and a third on an integration — three places to update when a
business changes domain, and three answers to "what is this customer's website".

## Decision

**A first-class `sites` table, owned by the workspace, not by any feature.**

```
sites   workspace_id, name, origin (canonical, normalised),
        status, verification_state, verified_at, created_by, timestamps
```

### 1. A workspace has MANY sites

Not `workspaces.website`. A plumbing business has its main site and a campaign
microsite; an agency's client has a brand site and a booking subdomain; a
business rebrands and runs both for a year.

Modelling one website per workspace is the kind of assumption that is cheap now
and requires a migration and a data-quality exercise later.

### 2. Origin, not domain

`https://www.abcplumbing.test` — scheme, host and port, normalised
(lowercased, `www.` preserved because `www.x` and `x` are genuinely different
origins to a browser, default ports stripped).

Origins are what browsers actually send in the `Origin` header and what CSP
`frame-ancestors` matches. Storing a bare domain would mean reconstructing an
origin at every comparison and getting the scheme wrong somewhere.

### 3. Configured ≠ verified, and the distinction is in the schema

```
verification_state:  unverified | pending | verified
```

**Stage 3 requires only `unverified`.** Embedding a form on a site you do not
own harms only you: submissions land in _your_ CRM, and the form key is yours.
Requiring DNS verification before a customer can paste an embed snippet would
be friction with nothing behind it.

**Stage 4 onwards will require `verified`.** Crawling implies "we may fetch
this at volume", and Search Console implies "we may read your search data" —
both are claims about ownership that a `TXT` record should back. The column
exists now so those stages tighten a check rather than adding a concept.

Recorded explicitly so nobody later reads "we have a sites table" as "we have
verified domains".

### 4. `sites` is a shared concept, not a CRM one

It lives in the database schema and is served by a small service, deliberately
**not** inside `@growth-os/crm`. A site is not a customer record; the crawler
and Search Console will need it and must not import the CRM to get it.

For Stage 3 it ships as `packages/database/src/schema/sites.ts` plus a service
in `packages/forms`, because a `@growth-os/sites` package with two functions
would be ceremony. **Stage 4 is the point to extract it** — that is when a
second, non-forms consumer appears, which is the actual trigger for a package.

### 5. Deleting a site does not delete its leads

`ON DELETE SET NULL` from forms. The acquisitions a site produced are
commercial history and survive it — the same reasoning as
[ADR-0020](ADR-0020-privacy-erasure.md).

## Alternatives considered

**`workspaces.website` (one string).** Smallest possible; wrong the first time
a customer runs a second domain, and wrong permanently once leads are attached
to the assumption.

**Per-feature origin config.** Three sources of truth, guaranteed to disagree.

**A full `@growth-os/sites` package now.** Correct destination, premature
today: one consumer, two functions. Extraction is a file move once a second
consumer exists, and doing it then means the boundary is drawn against real
usage rather than a guess.

**Require DNS verification in Stage 3.** Friction with no threat behind it for
embedding, and it would block the headline acceptance test on a DNS record.

## Consequences

### Positive

- One answer to "what is this customer's website", from Stage 3 onwards.
- Stage 4 inherits a model instead of inventing one.
- Multi-site is representable from the first row.
- Verification is a state transition later, not a new concept.

### Negative

- A table with one row for most workspaces initially — accepted.
- `verification_state` is inert in Stage 3 and could read as security theatre if
  someone does not read this ADR. Mitigated by labelling it "Not verified" in
  the UI rather than leaving it blank.

## Revisit when

- Stage 4 needs verification → implement the DNS/meta-tag flow.
- A second non-forms consumer exists → extract `@growth-os/sites`.

## Related

- [ADR-0026](ADR-0026-public-form-resolution.md) — allowed origins
- Stage 4 in [product-roadmap.md](../product/product-roadmap.md)
