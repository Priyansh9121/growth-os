# 0012 — Reordering the roadmap, and designing lead capture

**Date:** 2026-08-16 · **Stage:** 3

## Objective

Decide what Stage 3 is, and design the domain that lets an anonymous website
visitor become a truthfully attributed CRM lead.

## Initial state

Stage 2.5 complete: a CRM safe for real customer data, with merge, erasure,
canonical ingestion, bulk import, RLS forced on every workspace-owned table —
and **nothing writing into it except a human typing**.

The roadmap said Stage 3 was the website crawler.

## The reorder, and why

Stage 3 was changed from **Website Crawler** to **Lead Capture & Attribution
Ingestion**; the crawler became Stage 4. The full reasoning is recorded in
[the roadmap](../product/product-roadmap.md#roadmap-decision--reordering-stage-3)
rather than here, because it is a product decision that outlives this session.
The engineering half of it:

1. **Stage 2.5 built an ingestion boundary and nothing used it.** `ingestAcquisition`,
   idempotency receipts, provenance with required confidence, system-actor
   support — all built for automated writers, all exercised only by tests. Code
   with no caller is a hypothesis.

2. **The crawler produces analysis; lead capture produces revenue.** A crawler
   tells a business what is wrong with its website. A form tells it someone
   wants to buy. Only one of those closes a commercial loop.

3. **The crawler needs a site identity that lead capture also needs.** Building
   `sites` here means Stage 4 extends a model with real rows in it rather than
   inventing a second one.

4. **Attribution has to exist before there is anything to attribute.** Building
   the crawler first would mean retrofitting first-party provenance onto leads
   that had already arrived without it.

## Decisions

Six questions, six ADRs.

### 1. How does an anonymous browser reach a tenant-scoped database? — [ADR-0026](../decisions/ADR-0026-public-form-resolution.md)

The problem in one line: **RLS requires a workspace, and the caller has no
session.**

Rejected: disabling RLS on the public path (the isolation guarantee becomes
conditional on which endpoint you arrive at); a service role bypassing RLS (one
bug away from cross-tenant); the browser sending `workspaceId` (a tenant
selector supplied by an attacker).

Chosen: **one opaque 128-bit public key**, resolved by a single narrow
`SECURITY DEFINER` function with a pinned `search_path`, reading `forms` and
`form_versions` only. RLS is disabled nowhere. The worst it can leak is the
public configuration of a form whose key the caller already holds — which that
form renders to the open internet anyway.

The entropy is enforced by a database CHECK (`^[0-9a-f]{32}$`), not by the code
that generates keys, because the constraint has to hold for rows a future
importer writes too.

### 2. What may that path do once it is inside? — [ADR-0025](../decisions/ADR-0025-system-actors.md)

Not a role. **A capability grant of exactly `workspace:crm:contacts:write`.**

The weakest role holding that capability is `member`, which also holds
`opportunities:write`, `tasks:write`, `companies:write` and `tags:apply`.
Handing a public endpoint a role grants it five capabilities to use one.

The consequential part is not the grant, it is `actorUserId()`:

```ts
export function actorUserId(context: CrmContext): string {
  if (context.system) throw new Error(/* … */);
  return context.tenant.actor.userId;
}
```

It **throws**. Not returns null — throws, so any service that has not been
reviewed for system safety stops at the call rather than writing a fabricated
foreign key. Rejected alternative: creating a "System" user row, which is how a
fake human ends up in an audit trail that is supposed to answer "who did this?".

### 3. How is a form embedded? — [ADR-0027](../decisions/ADR-0027-embed-mechanism.md)

A **cross-origin iframe**, inserted by a 633-byte ES5 loader.

Rejected: injecting the form into the host page's DOM. It is what most vendors
do, and it means the customer's page — and every script on it, including an ad
network's — can read what a visitor types into the enquiry form. A cross-origin
iframe makes that structurally impossible rather than a matter of trust.

The cost is real and accepted: styling cannot inherit from the host page, and
resizing needs `postMessage`. Inbound messages are validated on origin, source
frame, form key and numeric bounds.

### 4. Where does attribution live? — [ADR-0028](../decisions/ADR-0028-attribution-storage.md)

`sessionStorage`, one key, tab lifetime, no cookies.

Rejected: a first-party cookie (a consent conversation for a business that may
not have had one, on a customer's domain we do not control) and `localStorage`
(persistent cross-session identification is tracking, and this needs to survive
a navigation, not a fortnight).

**First touch wins.** A visitor landing on `/emergency-plumber?utm_campaign=…`
and submitting from `/contact` is attributed to the campaign. The submission
page is recorded separately rather than overwriting it.

Truncation happens **in the browser**: paths without query strings, referrers
reduced to an origin. A legacy `?q=` never leaves the page.

### 5. What is a site? — [ADR-0029](../decisions/ADR-0029-web-properties.md)

An **origin**, not a URL, and **configured is not verified**. A workspace can
name any origin; nothing about that claims we proved they own it. Stage 4's
crawler will need real verification, and the model leaves room for it without
implying it exists now.

### 6. Background work — [ADR-0030](../decisions/ADR-0030-worker-and-queue.md)

PostgreSQL, `FOR UPDATE SKIP LOCKED`, in `apps/worker`. Covered in
[0014](0014-the-worker-and-a-hang.md).

## The classifier

The single most consequential piece of code in this stage is about forty lines
long and contains no AI:

```
gclid            → paid_search  / google   / declared
fbclid           → social       / facebook / declared
utm_medium=cpc…  → paid_*                  / derived
search referrer  → organic_search          / derived   ← never a keyword
social referrer  → social                  / derived
any referrer     → referral                / derived
campaign, no ref → unknown                 / inferred
nothing          → direct                  / inferred
```

**Deterministic, ordered, and auditable.** An LLM classifying first-party
acquisition would produce a plausible answer for a case nobody wrote down, and
the customer would have no way to tell that answer from a real one. Attribution
is the number a business decides its advertising budget on; a guess dressed as a
fact is worse than "unknown".

`declared` for click ids and `derived` for UTM parameters is not a formality: an
ad platform minted the click id, whereas anyone can put `utm_source=google` in a
URL.

### ⚠️ `searchQuery` is not in the return type

Not "left empty" — **absent from the type**. `utm_term` is the marketer's bid
keyword, a Google referrer carries no query (engines stopped passing it in
2011), and a landing path is a page. There is no signal on this path that could
truthfully populate it, so there is no field to populate. It comes from Search
Console and nothing else ([ADR-0012](../decisions/ADR-0012-provenance-model.md)).

## The rule the package exists to keep

**`@growth-os/forms` never inserts a CRM row.**

The public endpoint resolves, validates, classifies, and then calls
`ingestAcquisition`. A second ingestion path would mean two answers to "how is a
lead deduplicated?" and attribution would depend on which one ran. The only rows
forms writes are its own.

That rule is what turned Stage 2.5's untested boundary into a load-bearing one,
and it is why the reorder was worth doing.

## Files created

| Path                                                 | Purpose                       |
| ---------------------------------------------------- | ----------------------------- |
| `docs/decisions/ADR-0025`…`ADR-0030`                 | The six decisions above       |
| `packages/database/migrations/0007_lead_capture.sql` | Six tables, RLS, one function |
| `packages/forms/`                                    | The new package               |
| `packages/contracts/src/forms/`                      | Schemas and the classifier    |

### Schema notes

- `form_versions` has **no UPDATE and no DELETE policy**. The absence is the
  enforcement: a version is immutable, so a lead captured under version 3 still
  means what it meant. Editing writes a new version.
- The field **list** is JSONB while custom field **values** are rows
  ([ADR-0022](../decisions/ADR-0022-custom-field-storage.md)) — deliberately
  opposite, because a field list is read, written and versioned as a whole and
  never queried across forms, while values are filtered and must be enumerable
  by erasure.
- `form_submissions` is a **receipt**: outcome, ids, classified source, byte
  size. Not the payload. A submission archive would be a second, richer copy of
  every enquiry a business ever received, sitting outside erasure's reach.

## Security impact

| Property                                      | Mechanism                                     |
| --------------------------------------------- | --------------------------------------------- |
| A browser cannot select a tenant              | `workspaceId` is not in the submission schema |
| A browser cannot state provenance             | Neither are `sourceType` / `confidence`       |
| A browser cannot claim a search               | `searchQuery` is in no type on this path      |
| The public path cannot erase, merge or export | One capability, asserted by test              |
| RLS still applies to public writes            | The system context opens a tenant transaction |

## Testing

Unit tests over the pure decisions — mostly as negatives. The classifier suite
asserts what it **does not** produce as carefully as what it does.

## Result

Six decisions, one migration, one package. Nothing was reachable from a browser
yet; that is [0013](0013-the-public-path.md).

## Remaining work

- The public endpoint, the hosted form, the embed and the tracker.
- No challenge provider. The seam exists and its default is named
  `NoChallengeVerifier` so nobody mistakes it for protection.
