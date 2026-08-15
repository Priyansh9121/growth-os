# ADR-0011 — CRM domain model and package boundary

**Status:** Accepted
**Date:** 2026-08-15
**Context as of this date:** Stage 2. Stage 1 delivered tenancy, auth and the
shell. No customer data exists yet — the cheapest possible moment to fix the
domain model, and the last one.

## Context

The CRM is not a feature. It is the **downstream destination** every later
Growth OS capability writes into: SEO leads, website forms, tracked calls,
chat, voice AI, Google Ads, Facebook lead forms, manual entry, imports, the
public API and future automations.

If the CRM is modelled as "a table of people", attribution (Stage 15) becomes
impossible without a migration of live customer data. So the model must be
right now, not convenient now.

Two things had to be decided: **the entity shape**, and **where the code
lives**.

## Decision

### 1. Contact, Acquisition and Opportunity are three separate entities

They answer three different questions and have three different cardinalities.

| Entity          | Question                                   | Cardinality          |
| --------------- | ------------------------------------------ | -------------------- |
| **Contact**     | _Who is this?_                             | One person           |
| **Acquisition** | _How did they enter, and from where?_      | **Many per contact** |
| **Opportunity** | _What commercial outcome are we pursuing?_ | **Many per contact** |

Sarah Mitchell finds the site via organic search in March (acquisition 1),
calls from a Google Ads click in June (acquisition 2), and has two separate
jobs quoted (opportunities 1 and 2). Collapsing any pair of these loses
information that attribution needs and cannot reconstruct.

**Collapsing Contact and Acquisition** — the most common CRM mistake — puts
`source` on the person. The second visit then overwrites the first, and
first-touch attribution is gone forever.

**Collapsing Acquisition and Opportunity** asserts that every enquiry is a deal
worth pursuing. It is not: a lead may never become an opportunity, and an
opportunity may be worth $0 at creation.

### 2. The entity is named `acquisitions`, not `leads`

`docs/product/terminology.md` (Stage 1) already defines **Lead** as _"a
qualified enquiry judged worth pursuing"_ — a judgement, not an event. Reusing
that word for the raw entry record would contradict the existing vocabulary and
make "how many leads?" ambiguous forever.

An `acquisition` is the **immutable record of an entry event with provenance**.
Qualification is a separate, nullable fact on it (`qualified_at`,
`qualification`), so "leads this month" has one unambiguous definition:
acquisitions where `qualified_at IS NOT NULL`.

### 3. Stage 2 tables

`companies` · `contacts` · `acquisitions` · `pipelines` · `pipeline_stages` ·
`opportunities` · `tasks` · `activities` (+ `invitations`, ADR-0018).

### 4. Deferred, with reasons

| Deferred                 | Why                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tags` / `contact_tags`  | Stage 2 filtering (owner, source, date, status) covers the real need. Tags add a join, a management surface and a taxonomy problem for no current requirement |
| `notes` as its own table | `activities` already carries a `note` type. A separate mutable notes table duplicates the timeline and creates two places to look for "what was said"         |
| `custom_fields`          | A genuine future requirement (Stage 16+), and a genuine schema-design problem. Doing it badly now (an EAV junk drawer) is worse than not doing it             |

### 5. Money is stored as integer minor units

`estimated_value_cents bigint` plus an ISO-4217 `currency` column. Never
floating point: `0.1 + 0.2` is the wrong answer in every language, and a
rounding error in a pipeline value is a customer-visible defect.

### 6. Task relations are explicit columns, not polymorphic

`tasks.contact_id` and `tasks.opportunity_id` as real, nullable foreign keys —
rather than `subject_type` + `subject_id`.

Polymorphic references cannot have a foreign key, so the database cannot stop a
task pointing at a deleted contact, and cascade behaviour must be hand-written
and remembered forever. Two nullable FKs cost one column and buy referential
integrity. If a third and fourth subject type arrive, revisit — but the cost of
starting explicit is near zero and the cost of starting polymorphic is
permanent.

### 7. Code lives in a new `@growth-os/crm` package; schemas live in `@growth-os/contracts`

This split is the non-obvious part.

```
@growth-os/contracts/crm   Zod schemas + types  (pure, no I/O)
@growth-os/crm             application services (touches the database)
```

**Why schemas are NOT in the CRM package:** client components need
`createContactSchema` for form validation. If it lived in `@growth-os/crm`,
importing it from a `'use client'` component would pull the CRM package — and
therefore `@growth-os/database` and the PostgreSQL driver — into the browser
bundle. Keeping schemas in the pure `contracts` package makes that
architecturally impossible rather than merely discouraged.

New boundary edge: `crm → contracts, database`. **`crm` must not import
`auth`.** Services receive an already-authorized `TenantActor` and check
specific capabilities using `workspaceRoleHasCapability` from `contracts`,
which avoids a cycle and keeps CRM independent of how authentication happened.

## Alternatives considered

### A — Put the CRM in `apps/web` as a feature folder

_Attractive:_ fastest; no new package.

**Rejected:** the voice service (Stage 13) and worker (Stage 3) must call
`createContact` and `bookAppointment` without importing a Next.js application.
This is exactly the coupling [ADR-0001](ADR-0001-architecture-style.md) exists
to prevent, and the extraction cost grows with every route added.

### B — One `contacts` table with a `source` column

_Attractive:_ one table, no joins, obvious.

**Rejected:** it is a one-way door. The second acquisition overwrites the first,
and first-touch attribution — the thing the entire product is for — becomes
unrecoverable. There is no migration back once customer data exists.

### C — Separate `leads` table that is promoted into a contact

_Attractive:_ matches Salesforce's lead/contact conversion model, which many
users have seen.

**Rejected:** it creates two identity tables and a conversion event, so
"how many people do we know?" requires a union and deduplication across both.
Our model gets the same outcome with one identity table and a qualification
flag, and avoids the duplicate-identity problem entirely.

### D — Event-sourced CRM

_Attractive:_ a perfect fit for a timeline, and full history for free.

**Rejected:** the events cannot be named correctly yet — event sourcing
punishes an unstable domain model, because the events _are_ the schema. We take
the useful half (an append-only `activities` timeline and typed domain events)
without committing to the whole pattern. Same reasoning as
[ADR-0001](ADR-0001-architecture-style.md).

## Consequences

### Positive

- Attribution is possible without a data migration.
- One contact, many acquisitions, many opportunities — the real-world shape.
- Voice, SEO and automation can all write through the same services.
- Client bundles cannot pull in the database driver.

### Negative

- More joins than a single-table design. Mitigated by indexes matching real
  query paths.
- "Source" on the contacts list requires a lateral join to the first
  acquisition rather than a column read. Accepted at Stage 2 scale; the
  denormalisation trigger is named in `data-architecture.md`.
- Three entities to explain to users. The UI must not expose the word
  "acquisition" — it says "source" and "where they came from".

### Risks and mitigations

| Risk                                          | Mitigation                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Users conflate leads and opportunities        | Terminology is fixed in `docs/product/terminology.md`; UI copy is derived from it                                                              |
| A future table forgets `workspace_id`/RLS     | Checklist in `docs/security/tenant-isolation.md`, plus an integration test that enumerates tenant tables and asserts RLS is enabled and forced |
| `crm` accidentally imports `auth` or `apps/*` | Lint rule **plus** adversarial probes in `scripts/verify-boundaries.mjs`                                                                       |

## Revisit when

- Custom fields are requested by a paying customer.
- A third task subject type appears → reconsider polymorphism.
- Contacts exceed ~1M per workspace → revisit the lateral-join source lookup.

## Related

- [ADR-0012](ADR-0012-provenance-model.md) — provenance
- [ADR-0013](ADR-0013-soft-deletion-and-retention.md) — deletion
- [ADR-0014](ADR-0014-activity-vs-audit.md) — timeline vs audit
- [architecture/crm-architecture.md](../architecture/crm-architecture.md)
