# CRM Architecture

**Status:** Implemented (Stage 2)
**Last reviewed:** 2026-08-15
**Governing ADRs:** [0011](../decisions/ADR-0011-crm-domain-model.md) ·
[0012](../decisions/ADR-0012-provenance-model.md) ·
[0013](../decisions/ADR-0013-soft-deletion-and-retention.md) ·
[0014](../decisions/ADR-0014-activity-vs-audit.md) ·
[0015](../decisions/ADR-0015-contact-identity-and-deduplication.md) ·
[0016](../decisions/ADR-0016-list-pagination-and-filtering.md)

---

## 1. What the CRM is for

The CRM is **not a feature**. It is the downstream destination every later
Growth OS capability writes into:

```
SEO leads ─┐
forms ─────┤
calls ─────┤
chat ──────┼──▶ @growth-os/crm ──▶ contacts · acquisitions · opportunities
voice AI ──┤         services              tasks · activities
ads ───────┤
imports ───┤
API ───────┘
```

Every one of those paths funnels through the same services, so all of them
produce the same validated shape with the same provenance discipline. A future
integration cannot invent its own half-complete notion of "source".

## 2. The three-entity spine

| Entity          | Question                                   | Cardinality          |
| --------------- | ------------------------------------------ | -------------------- |
| **Contact**     | _Who is this?_                             | one per person       |
| **Acquisition** | _How and from where did they arrive?_      | **many** per contact |
| **Opportunity** | _What commercial outcome are we pursuing?_ | **many** per contact |

Sarah finds the site organically in March, calls from an ad in June, and has
two jobs quoted. That is **1 contact, 2 acquisitions, 2 opportunities** — and
collapsing any pair loses information attribution cannot reconstruct.

**Why `acquisitions`, not `leads`:** `terminology.md` already defines a _lead_
as a qualified enquiry — a judgement. An acquisition is the immutable **event**.
Qualification is a nullable fact on it, so "leads this month" has exactly one
definition: `acquisitions WHERE qualified_at IS NOT NULL`.

## 3. Package layout, and why schemas are split from services

```
@growth-os/contracts/crm    Zod schemas + view types    (pure, no I/O)
@growth-os/crm              application services        (touches the database)
```

This split is the non-obvious part and it exists for one reason: **a client
component needs `createContactSchema` for form validation.** If schemas lived
in the service package, importing one from `'use client'` code would pull
`@growth-os/database` and the PostgreSQL driver into the browser bundle.
Keeping them in the pure package makes that architecturally impossible.

New boundary edge: `crm → contracts, database`. **`crm` must not import
`auth`** — that would cycle, and would couple the CRM to how authentication
happened, which the voice service (Stage 13) will not share. Capability checks
resolve through `workspaceRoleHasCapability` from `contracts`.

Enforced by lint and _verified adversarially_ by
`scripts/verify-boundaries.mjs`, which now proves 14 illegal edges fail.

## 4. The service contract

Every service has the same shape:

```ts
async function doThing(
  context: CrmContext,
  input: ValidatedInput,
): Promise<View>;
```

```ts
interface CrmContext {
  deps: { db; events };
  tenant: TenantActor; // proof of authorization — not a raw workspace id
  correlationId: string | null;
}
```

Four properties hold everywhere:

1. **`requireCapability` first.** Before any query.
2. **`inTenant`** opens a transaction with `SET LOCAL app.workspace_id`, so RLS
   constrains every statement.
3. **`loadInTenant`** is the only way to resolve an id.
4. **Views, not rows.** A Drizzle row is never returned to a caller.

### The IDOR defence is an API shape, not a convention

There is deliberately **no `findById(id)`** anywhere in the package. The
insecure pattern —

```ts
const contact = await findById(id);
if (contact.workspaceId !== actor.workspaceId) throw new Error(); // too late
```

— is not merely discouraged; it is **not expressible**, because no function
offers it. The workspace is a required parameter of the only loader, so it is
part of the query rather than a check on the result.

## 5. Provenance

Recorded on the **acquisition**, never on the contact.

```ts
{ sourceType, sourcePlatform, confidence, landingPath, referrerOrigin,
  utm*, gclid, fbclid, searchQuery?, channelDetail?, metadata? }
```

**`confidence` is required and has no default.** An ingestion path must state
how much its own data can be trusted: `declared` (a source system reported it),
`derived` (browser signals — spoofable, often absent), `inferred` (our
heuristic — must be visibly labelled), `manual` (a human typed it).

### The `searchQuery` rule

> **`searchQuery` may only be set when `confidence === 'declared'`.**

Search engines have not passed the query in the referrer since 2011. A keyword
that did not come from Search Console or an Ads platform would fabricate the
single number this product is sold on.

Enforced **three times**, deliberately:

1. `assertProvenanceIntegrity` in contracts, before the transaction opens.
2. Again inside `insertAcquisition`.
3. A PostgreSQL trigger, `crm_acquisitions_provenance_immutable`, which rejects
   any UPDATE that touches a provenance column — so even a future service that
   tried to back-fill a keyword is refused by the database.

Also enforced: the landing page stores a **path with the query string
stripped**, because query strings routinely carry PII in click-through links.

## 6. Atomicity — the `moveStage` example

```
validate stage belongs to pipeline
  → optimistic concurrency check (expectedCurrentStageId)
    → UPDATE stage + status + closed_at
      → INSERT activity
        → publish domain event
```

All inside **one transaction**. A card that moved without its timeline entry,
or a `status` that disagrees with its stage, is the inconsistency this shape
prevents. The UI never writes the two separately, and the API exposes a
dedicated `PATCH /stage` endpoint rather than a general field update, because
moving stage is not a field edit.

`status` mirrors the stage's **`category`**, never its name — so a workspace
renaming "Won" to "Job Booked" does not break win-rate reporting.

## 7. Activity vs audit

Two systems, two audiences ([ADR-0014](../decisions/ADR-0014-activity-vs-audit.md)).

|          | `activities`                        | `audit_events`                  |
| -------- | ----------------------------------- | ------------------------------- |
| Answers  | _What happened with this customer?_ | _Who changed our data?_         |
| Read by  | every operator                      | admins (`workspace:audit:read`) |
| PII      | **yes, deliberately**               | **no — identifiers only**       |
| Deletion | none (append-only)                  | never                           |

One action commonly writes both, in one transaction. Both are authored by
application services — **never** accepted from a client, which could otherwise
assert arbitrary history.

## 8. Deletion semantics, per entity

| Entity              | Semantics                                             |
| ------------------- | ----------------------------------------------------- |
| contacts, companies | soft delete (`deleted_at`)                            |
| opportunities       | close (`status`, `closed_at`) — a lost deal is a fact |
| tasks               | cancel — abandoning work is an outcome                |
| pipelines, stages   | archive — must not orphan referencing rows            |
| acquisitions        | none — immutable provenance                           |
| activities          | none — append-only                                    |

**Soft delete is not GDPR erasure.** Erasure is a separate, privileged, audited
path that is **not implemented** and is a named prerequisite before the first
real customer.

## 9. Identity and deduplication

Normalisation produces the matching keys: email is `trim + lowercase` **only**
(no Gmail-specific dot or `+alias` stripping — that silently merges different
people at other providers); phone is parsed to **E.164** using the
**workspace's** region, never a global constant.

**Deduplication reports; it never merges.** `createContact` returns a
`duplicateOf` candidate on an exact normalised email or phone match. Names are
never used — two "James Carter"s are two customers. Merging is destructive and
effectively irreversible, and shared mailboxes (`office@`, `info@`) are
extremely common in the target segment.

Merge is designed and deferred: choose a survivor, re-point
acquisitions/opportunities/tasks/activities, write a `contact.merged` activity,
retain a reversal window.

## 10. Events

Typed domain events (`crm.contact.created`, `crm.opportunity.stage_changed`, …)
published to an in-process bus. **Payloads carry identifiers, never PII** —
events fan out to subscribers, queues and logs, so a name or email in one is
distributed everywhere by default.

Stage 12 replaces the transport with a transactional outbox. The event _names
and shapes_ are the expensive part to change, so they are committed to now.

⚠️ Known limitation: in-process delivery is best-effort and fires even if the
surrounding transaction later rolls back. The outbox fixes that.

## 11. Not built

|                        | Stage                                                   |
| ---------------------- | ------------------------------------------------------- |
| Contact merge          | 3                                                       |
| Tags, custom fields    | 3 / 16                                                  |
| Companies UI           | 3                                                       |
| Import / export        | 3                                                       |
| GDPR erasure           | before first real customer                              |
| Drag-and-drop pipeline | follow-up — needs an accessible keyboard protocol first |
| AI write tools         | 7, with the approval workflow                           |
