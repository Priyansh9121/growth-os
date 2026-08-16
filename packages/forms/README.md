# @growth-os/forms

Lead capture: web properties, form configuration and versioning, and the
**public submission path**.

## Responsibility

Turning an anonymous browser submission into a truthfully attributed CRM lead —
without this package ever writing a CRM row itself.

```
public submission
  → resolve the form (and therefore the tenant)
  → abuse controls
  → validate against the published version
  → classify the source deterministically
  → ingestAcquisition(...)        ← @growth-os/crm owns every CRM write
  → record a receipt
```

## The rule this package exists to keep

**It never inserts a contact, an acquisition or an opportunity.** Those are
`@growth-os/crm`'s, through `ingestAcquisition`. A second ingestion path would
mean two answers to "how is a lead deduplicated?", and attribution would depend
on which one happened to run ([ADR-0021](../../docs/decisions/ADR-0021-ingestion-and-idempotency.md)).

The only rows this package writes are its own: sites, forms, versions and
submission receipts.

## Contains

| Path | Purpose |
| ---- | ------- |
| `shared/` | The forms execution context, capability guards, origin normalisation |
| `sites/` | Web properties — shared with the Stage 4 crawler |
| `forms/` | Admin CRUD, versioning, publishing |
| `public/` | Form resolution, abuse controls, the submission service |
| `tracking/` | Attribution context sanitisation |

## May depend on

`@growth-os/contracts`, `@growth-os/crm`, `@growth-os/database`, `drizzle-orm`,
`zod`, `node:crypto`.

## Must NOT

- Import `@growth-os/auth` (cycle), `@growth-os/ui`, React, Next.js, or
  anything in `apps/`.
- Import `node:fs`. Same rule as the CRM: nothing here writes to disk.
- Insert CRM rows directly.
- Decide who the caller is — it receives an already-resolved actor, human or
  system.

## Security boundary

**This package owns the product's first anonymous public write path.**

- The browser never selects a tenant. A form's public key resolves to exactly
  one workspace through one narrow `SECURITY DEFINER` function
  ([ADR-0026](../../docs/decisions/ADR-0026-public-form-resolution.md)).
- Public ingestion runs under a **system grant** of exactly
  `workspace:crm:contacts:write` — not a role
  ([ADR-0025](../../docs/decisions/ADR-0025-system-actors.md)).
- The browser cannot state `sourceType`, `confidence` or `searchQuery`. Those
  are derived server-side from raw signals by deterministic code.
- No raw payload is ever stored.

## Testing

Unit tests over the pure decisions — source classification, origin matching,
value mapping, abuse signals — mostly as negatives. Integration tests against a
real database as a **restricted non-owner role**, covering tenant isolation,
idempotency under retry, and the full submission → CRM path.
