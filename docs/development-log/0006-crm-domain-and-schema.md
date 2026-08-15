# 0006 — CRM domain design and tenant-isolated schema

**Date:** 2026-08-15 · **Stage:** 2

## Objective

Design and build the commercial data foundation every later Growth OS
capability writes into, with provenance as a first-class concept rather than a
column added later.

## Initial state

Stage 1 complete at `36f6b5f`: 203 files, 116 tests, 7 tables, one tenant table
(`audit_events`) carrying RLS. No customer data of any kind.

## Investigation

Two questions had to be settled before any schema was written.

**1. Is "source" a property of a person or of an arrival?** Of the arrival.
Sarah finds the site organically in March and calls from an ad in June. If
`source` is a column on `contacts`, June overwrites March and first-touch
attribution is gone permanently — with no migration back once real data exists.
That single observation forced the three-entity spine.

**2. Is RLS actually enforced against the CRM tables?** Verified directly
rather than assumed, as in Stage 1:

```
 acquisitions | t | t     contacts      | t | t
 activities   | t | t     opportunities | t | t   … 9 CRM tables, all forced
```

## Decisions

Six ADRs, each with rejected alternatives and costs:

| ADR  | Decision                                              | The deciding factor                                            |
| ---- | ----------------------------------------------------- | -------------------------------------------------------------- |
| 0011 | Contact / Acquisition / Opportunity as three entities | Collapsing any pair is a one-way door                          |
| 0012 | Provenance with required `confidence`                 | An attribution report built on guessed data is worse than none |
| 0013 | Deletion semantics chosen per entity                  | "Soft delete everything" makes history mutable                 |
| 0014 | Activity and audit are separate systems               | Incompatible PII and access requirements                       |
| 0015 | Dedup reports, never merges                           | A wrong merge is destructive and irreversible                  |
| 0016 | Keyset pagination, closed filter set                  | Offset skips rows; a filter DSL is an authorization bypass     |

Three implementation choices worth recording:

- **The entity is `acquisitions`, not `leads`.** `terminology.md` already
  defined "lead" as a _judgement_. Reusing it for the raw event would have made
  "how many leads?" permanently ambiguous. Qualification is now a nullable
  column, so the question has exactly one answer.
- **Zod schemas live in `contracts`, services in `crm`.** A client component
  needs `createContactSchema`; if it lived beside the services, importing it
  from `'use client'` code would pull the PostgreSQL driver into the browser.
- **Provenance immutability is a database trigger**, not a service convention.
  A rule every present and future service must remember is a rule that will
  eventually be forgotten.

## Alternatives considered

- **One `contacts` table with a `source` column** — rejected; the one-way door
  above.
- **Salesforce-style lead→contact conversion** — rejected; two identity tables
  means "how many people do we know?" needs a union and a dedup.
- **Event-sourced CRM** — rejected; the events cannot be named correctly yet,
  and event sourcing punishes an unstable domain model.
- **Polymorphic task subjects** — rejected; a polymorphic reference cannot
  carry a foreign key, so the database could not stop a task pointing at a
  deleted contact.

## Files created

`packages/contracts/src/crm/` (enums, provenance, schemas, events) ·
`packages/database/src/schema/crm.ts` · migrations `0002_crm_foundation.sql`
(9 enums, 9 tables, 28 indexes, 4 partial) and
`0003_crm_row_level_security.sql` (hand-written RLS + the immutability trigger).

## Files modified

`capabilities.ts` (11 CRM capabilities, mapped so `member` cannot archive a
contact or reshape a pipeline) · `schema/tenancy.ts` (`default_phone_region`) ·
`schema/audit.ts` (CRM audit event names).

## Architecture impact

The tenant table count went from 1 to 10. Every one has `workspace_id`, an
index, RLS `ENABLED` **and** `FORCED`, and per-operation policies chosen to
match its deletion semantics — `activities` has no UPDATE or DELETE policy at
all, so append-only is enforced by the _absence_ of a policy.

## Security impact

Nine new tables holding the first real customer PII, each covered by the
three-layer isolation model. The provenance trigger adds a fourth, narrower
guarantee: a lead's source cannot be rewritten by anything, including a future
bug.

## Testing

Migration verified against real PostgreSQL. Partial indexes, FK actions
(2 `restrict`, 16 `cascade`, 19 `set null`) and enum generation all reviewed in
the emitted SQL before merge.

## Result

16 tables, RLS on all 10 tenant tables, and a schema attribution can be built
on without touching customer data.

## Remaining work

Services, API and UI — entry 0007.
