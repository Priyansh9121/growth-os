# 0010 — Merge, erasure, ingestion and import: implementation

**Date:** 2026-08-15 · **Stage:** 2.5

## Objective

Build the six subsystems designed in [0009](0009-data-lifecycle-design.md), and
prove each one by testing the property rather than the implementation.

## Initial state

Six ADRs, no code. Nine CRM tables, RLS on all of them.

## What was built

| Piece               | Where                                     | Shape                                                                      |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| Seven tables        | `0004_crm_data_lifecycle.sql`             | tags, contact_tags, contact fields ×2, receipts, batches, erasures         |
| Two SQL functions   | same                                      | `crm_merge_contacts`, `crm_erase_contact` — the only sanctioned escalation |
| Merge               | `crm/src/contacts/merge.ts`               | Preview + execute; conflict resolution in TypeScript, re-homing in SQL     |
| Erasure             | `crm/src/contacts/erasure.ts`             | Anonymise in place; `countTracesOf` for verification                       |
| Ingestion           | `crm/src/ingestion/service.ts`            | One boundary; receipts; `trust` seam for Stage 3 anti-abuse                |
| CSV                 | `crm/src/import/`                         | First-party RFC 4180 parser; validate-then-chunk                           |
| Tags, custom fields | `crm/src/tags/`, `crm/src/custom-fields/` | Controlled vocabulary; typed definitions                                   |

## Verification approach

**The erasure test searches for the name; it does not check the columns the
implementation happens to clear.**

```ts
expect(await countTracesOf(owner, 'Nadia')).toBe(0);
```

A test written against the implementation would pass even if the
implementation missed a column. This one cannot — which is exactly what made it
useful, twice.

The database suite is deliberately mostly **negative**: "merge moves the rows"
would pass even if the escalation were a blanket bypass. "An ordinary UPDATE on
`activities` is still refused", "merge cannot rewrite a summary", "erasure
cannot change where a lead came from" would not.

## Failures encountered

### 1. Erasure missed a task attached only to an opportunity

Found by running the erasure against a fixture and searching for the name
afterwards, before any of it was committed.

`tasks.contact_id` and `tasks.opportunity_id` are **independently nullable**,
so a task raised against a deal carries no `contact_id` at all — while its
title still reads _"Quote hot water for Sarah Mitchell"_. Keying erasure on
`contact_id` alone left it behind **and reported success**, which is the worst
possible outcome for a privacy feature.

Fixed by reaching tasks and activities through the contact's opportunities and
acquisitions as well as directly. The fixture in
`crm-lifecycle.integration.test.ts` now contains exactly that row, with a
comment naming it as the reason the suite was worth writing.

### 2. Two CHECK constraints were lost while composing the migration

The final migration was assembled from Drizzle's generated DDL (so foreign-key
constraint NAMES match the snapshot and future `generate` runs produce no
spurious diff) plus the hand-written RLS, functions and constraints. A block
removal during that composition took `contact_field_values_exactly_one_value`
with it.

Caught by the integration suite within minutes: a row with no value at all, and
a row with two, were both accepted. Both databases were rebuilt from migration
zero afterwards — which also proved 0004 applies to a clean schema, not only to
one that already had the 0002/0003 state.

### 3. `sql\`col = any(${jsArray})\`` again

postgres.js binds a JS array inside a template as a single scalar; PostgreSQL
rejects it as a malformed array literal. Same class of bug as Stage 2's, in a
new place, and fixed the same way — `inArray`. Worth recording twice: the
construct reads correctly and fails only at runtime.

### 4. The append-only trigger blocked deleting a user — found by E2E

`activities.actor_user_id` is `ON DELETE SET NULL`, so `DELETE FROM users`
makes PostgreSQL issue `UPDATE activities SET actor_user_id = NULL` with **no
lifecycle flag**, because no application code is involved. The trigger raised,
and the delete failed.

**Any user who had ever authored a timeline entry could not be deleted** —
after a few minutes of use, every user.

Nothing else caught it. Unit tests have no cascades. The integration harness
truncates with `TRUNCATE ... CASCADE`, which fires no row triggers. The E2E
suite seeds by `DELETE FROM users`, so it hit it on the first run.

Fixed in `0006_activities_actor_cascade.sql` by permitting **exactly** the
shape of a `SET NULL` cascade — `actor_user_id` going to NULL with every other
column unchanged. The looser fix, dropping `actor_user_id` from the frozen
list, would have let a merge or erasure quietly reassign authorship of history:
a worse property than the bug. Two regression tests now cover both the cascade
and a cascade-shaped statement that also changes something else.

## Architecture impact

- **A second escalation path exists in the database.** Documented in
  [data-lifecycle.md §6](../security/data-lifecycle.md), including what it does
  not guarantee.
- **`ingestAcquisition` is now the single automated-write boundary.** Stage 3's
  crawler-driven lead capture calls it rather than `createContact`.
- **The CRM may not import `node:fs`** — a new lint rule with a boundary probe.
  The convenient thing to do under time pressure is to spool an upload to
  `/tmp`; a rule beats a convention.

## Security impact

| Property                                | Enforcement                                                             |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Tenant isolation on 7 new tables        | RLS **enabled and forced**, asserted per table                          |
| Merge/erase confined to one workspace   | `p_workspace = app_current_workspace_id()` at function entry            |
| Correct even with RLS inert             | Every statement inside carries its own workspace predicate              |
| Timeline still append-only              | No general UPDATE policy; column trigger as an independent second check |
| Provenance still immutable              | Frozen under merge and erasure as well as ordinary operation            |
| Retries cannot inflate lead counts      | Receipts, plus no event published for a duplicate                       |
| Mapping cannot target arbitrary columns | Closed `IMPORT_FIELD_TARGETS` enum                                      |

## Testing

```
npm test                 # 332 → 353 passing
npm run verify:boundaries  # 17 probes (was 14)
```

70 new tests across three suites: 36 database-layer, 36 service-layer, 26 CSV
parser. Every database assertion runs as a **restricted, non-owner role**.

## Result

Merge, erasure and idempotent ingestion work and are proven by tests that would
fail if the implementation were subtly wrong rather than obviously broken.

## Remaining work

The interface, password reset and the CI bundle gate
([0011](0011-lifecycle-interface-and-reset.md)).
