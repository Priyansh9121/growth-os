# 0007 — CRM services, API and interface

**Date:** 2026-08-15 · **Stage:** 2

## Objective

Build the application services, HTTP boundary and operator interface on the
Stage 2 schema — with tenant isolation expressed in the _shape_ of the API
rather than as a rule to remember.

## Initial state

Schema and ADRs complete ([0006](0006-crm-domain-and-schema.md)). No runtime
CRM code.

## Investigation

The design question was how to make IDOR hard to write rather than merely
forbidden. Every CRM route takes a guessable id:

```ts
const contact = await findById(id); // any tenant's row
if (contact.workspaceId !== actor.workspaceId)
  // too late — already read
  throw new AuthorizationError();
```

Prohibiting that in a code-review checklist works until the reviewer is busy.
Instead, `@growth-os/crm` exposes **no** `findById`. The only loader is
`loadInTenant(tx, table, workspace, id)`, whose signature requires the
workspace, so the insecure form cannot be expressed at all.

## Decisions

1. **`CrmContext` carries a `TenantActor`**, not a workspace string. The only
   way to obtain one is `requireWorkspaceAccess`, so a service cannot be called
   without authorization having happened.
2. **Views, never rows.** A Drizzle row exposes internal columns
   (`emailNormalised`) and makes every schema change a breaking API change.
3. **`moveOpportunityStage` is one transaction** — stage, status, `closed_at`,
   activity and event together. It has its own endpoint because moving a deal
   is not a field edit.
4. **No optimistic lies in the pipeline UI.** The card settles only after the
   server confirms. `expectedCurrentStageId` gives optimistic concurrency, so
   two operators dragging the same card produce a 409 rather than a silent
   last-writer-wins.
5. **Movement is a `<select>`, not drag-and-drop.** An accessible DnD
   implementation needs its own keyboard protocol, live-region announcements
   and a drop-target model; a pointer-only version would make the primary sales
   surface unusable without a mouse. Recorded as follow-up.

## Failures encountered — the useful part

**A nested transaction deadlocked the seed.** `pipelineStageTotals` opened its
own transaction via `inTenant` while being called from inside
`getPipelineInTransaction`. postgres.js took a second connection from the pool,
which could not see the outer transaction's uncommitted rows — and hung. The
seed script never completed.

Fixed by making `stageTotalsInTransaction` take `tx` as a **required
parameter**, putting the rule in the type system rather than in a comment. The
rule it encodes: _a function that may be called from within a transaction must
accept that transaction rather than opening its own._

**Two array-binding bugs.** `sql\`col = any(${jsArray})\`` cannot serialise a
JS array through postgres.js, and `sql\`${col} < ${jsDate}\``cannot bind a
Date. Both surfaced only by running the code —`inArray()`and`lt()` fix them.
Worth recording because both typecheck cleanly and fail at runtime.

**A test caught real sloppiness in `splitLandingUrl`.** With a base URL,
`new URL()` almost never throws, so `'::::'` would have been stored as the
landing path `/::::`. Added a shape check before parsing.

## Files created

`packages/crm/src/**` (context, pagination, normalisation, six services,
events) · `apps/web/src/app/api/crm/**` (7 route handlers) ·
`apps/web/src/components/crm/**` (contacts table, create dialog, pipeline
board, tasks list, timeline, source badges) · three CRM pages ·
`server/crm-context.ts`, `server/crm-server.ts`, `server/growth-snapshot.ts`.

## Files modified

`navigation.ts` (contacts/pipeline/tasks now `built`) · dashboard page (live
CRM metrics) · `eslint.config.mjs` + `verify-boundaries.mjs` (six new edges) ·
seed script.

## Architecture impact

A fifth package, `@growth-os/crm`, with the edge `crm → contracts, database`
and an explicit prohibition on `crm → auth`. Boundary count went from 8 to 14
adversarial probes, all passing.

The dashboard now mixes **live** and **fixture** metrics with per-metric
provenance, and the banner says "Mixed data" rather than claiming everything is
demo or everything is real.

## Security impact

Seven new authenticated endpoints, each with origin validation on writes,
capability checks, tenant-scoped resolution and safe errors. AI gained five
read-only tools whose outputs are deliberately minimised — aggregates and first
names, never an email address or phone number, because tool output becomes
model context sent to a third party.

## Testing

Verified live against the running app: cross-tenant contact by id returns
**404** (not 403), a different tenant's contact list returns **0 items**, and a
CRM write without an `Origin` header returns **403**.

## Result

A working, tenant-safe, provenance-aware CRM: contacts with search and
pagination, a contact timeline, a Kanban pipeline with atomic movement, tasks,
and honest dashboard metrics.

## Remaining work

Merge, tags, import/export, companies UI, GDPR erasure — all recorded in
`crm-architecture.md` §11.
