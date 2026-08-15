# @growth-os/crm

CRM application services: contacts, companies, acquisitions, pipelines,
opportunities, tasks and the activity timeline.

## Why it exists

The CRM is the **downstream destination** every later Growth OS capability
writes into — SEO leads, forms, tracked calls, chat, voice AI, ads, imports and
the public API. Putting it in a package rather than in `apps/web` means the
worker (Stage 3) and the Python voice service's HTTP boundary (Stage 13) call
the same `createContact` and `createOpportunity` a browser does, instead of
each re-implementing them.

## Responsibilities

- The contact lifecycle, including atomic contact + first-acquisition creation
- Provenance capture and its integrity rules
- Identity normalisation and duplicate **detection**
- Pipelines, stages and atomic stage movement
- Tasks, and the append-only activity timeline
- Typed domain events for future automation

## NOT its responsibilities

- **Deciding who the caller is.** It receives an already-authorized
  `TenantActor` and checks specific capabilities against it.
- HTTP, rendering, or any framework concern.
- Zod schemas and view types — those live in `@growth-os/contracts/crm` so
  client components can import them without pulling in the database driver.

## Dependencies

`@growth-os/contracts`, `@growth-os/database`, `drizzle-orm`,
`libphonenumber-js`, `zod`.

**Never** `@growth-os/auth` (would cycle), `@growth-os/ui`, React, Next.js, or
anything in `apps/`. Enforced by lint and proven by
`scripts/verify-boundaries.mjs`.

## The three things to understand before changing this package

### 1. There is no `findById`

The only way to load a row is `loadInTenant(tx, table, workspace, id)`. The
insecure pattern — fetch by id, then check `row.workspaceId` afterwards — is
not merely discouraged here, it is **not expressible**, because no function
offers it. The workspace is part of the query, not a check on the result.

Do not add a loader that takes an id without a workspace.

### 2. A function that may run inside a transaction must ACCEPT one

`recordActivity`, `insertAcquisition` and `stageTotalsInTransaction` all take
`tx` as a required parameter.

This is not stylistic. An earlier version of `pipelineStageTotals` opened its
own transaction via `inTenant` while being called from inside another. That
took a second connection from the pool, which could not see the outer
transaction's uncommitted rows — and deadlocked. The seed script hung on it.

If a function might be called mid-transaction, it takes `tx`.

### 3. Provenance is defended three times

`searchQuery` may only be set when `confidence === 'declared'`. Checked in
`assertProvenanceIntegrity` (contracts), again in `insertAcquisition`, and
enforced by the PostgreSQL trigger `crm_acquisitions_provenance_immutable`,
which rejects any UPDATE touching a provenance column.

That is deliberate redundancy. A fabricated search keyword corrupts the exact
number Growth OS is sold on, and would be indistinguishable from a real one
once stored.

## Layout

```
src/
  shared/       CrmContext, capability guards, loadInTenant, pagination
  identity/     email/phone/website normalisation — the dedup matching keys
  contacts/     contact lifecycle + duplicate detection
  companies/    organisations
  acquisitions/ the provenance write path
  pipelines/    pipeline + stage configuration, default template
  opportunities/ deal lifecycle, atomic stage movement
  tasks/        work queue, human- and (later) agent-created
  activities/   the append-only timeline writer and reader
  events/       in-process domain event publisher
```

## Testing

Unit tests for the pure logic (normalisation, pagination). The behaviour that
matters most — tenant isolation across all eight CRM tables — is tested in
`@growth-os/database`'s integration suite, connected as a **restricted
non-owner role**, because RLS is what those tests are actually exercising.
