# ADR-0022 — Custom fields: typed definitions, relational values

**Status:** Accepted
**Date:** 2026-08-15

## Context

A plumbing business wants "Property Type". A dental practice wants "Patient
Type". A dealership wants "Vehicle Rego". These cannot be schema columns —
every workspace needs different ones — and they will hold customer PII, so they
must be reachable by erasure and constrained by tenant isolation.

## Decision

**Typed definitions plus a relational value table.**

```
contact_field_definitions  workspace, key, label, type,
                           required, options[], position, archived_at
contact_field_values       workspace, definition_id, contact_id → contacts(id),
                           value_text | value_number | value_boolean | value_date
```

Five types only: `text` · `number` · `boolean` · `date` · `single_select`.
No formulas, no computed fields, no cross-record references — those are a
different product with a different risk profile.

### Why contact-scoped, with a real foreign key

The obvious generalisation is `entity_type` + `entity_id`, so one pair of
tables serves contacts, companies and deals. That is a **polymorphic
reference**, which [ADR-0011](ADR-0011-crm-domain-model.md) §6 already rejected
for tasks and rejects again here: a polymorphic column cannot carry a foreign
key, so the database could not stop a value row pointing at a contact that no
longer exists, and cascade behaviour would have to be hand-written and
remembered forever.

It matters more here than it did for tasks, because these rows hold PII.
Erasure needs `ON DELETE CASCADE` and a join the planner can verify — not a
convention that a `WHERE entity_type = 'contact'` clause is never forgotten.

Companies get their own pair when they need one. Two small tables with real
integrity beat one clever table without it.

### Why typed columns rather than one `value` text column

A `date` stored as text cannot be range-queried or sorted correctly, and a
`number` stored as text sorts `"10" < "9"`. Four nullable typed columns with a
constraint that exactly one is populated costs a little width and buys correct
comparison for free.

### Why not `contacts.custom_data JSONB`

The brief names this as the thing to avoid, and it is right:

- **Erasure cannot find it.** [ADR-0020](ADR-0020-privacy-erasure.md) requires
  every PII location to be enumerable. A free-form JSON blob is exactly the
  "shadow PII store" that erasure misses.
- **No validation.** A "number" field would accept `"probably 40ish"`, and the
  first report over it fails.
- **No governance.** Renaming a field, changing its type, or knowing which
  workspaces use it all become impossible.
- **Migration.** Changing a key means rewriting every row's JSON.

A definitions table makes the schema self-describing: erasure joins to it, the
UI renders from it, and validation derives from it.

### Why not one column per custom field (dynamic DDL)

Genuinely fast to query, and rejected: it means the application issues `ALTER
TABLE` at runtime, on a shared multi-tenant table, on behalf of a customer.
Lock contention, unbounded column growth and a migration story that cannot be
reviewed.

### Values are validated against their definition on write

`single_select` values must appear in the definition's `options`. `number` must
parse. `required` is enforced at the service, not the database — a field made
required later must not invalidate existing rows.

### Definitions are archived, never deleted

Deleting a definition would orphan or cascade-delete its values, destroying
data a workspace entered. `archived_at` hides it from forms while keeping
history readable. Same reasoning as pipeline stages
([ADR-0013](ADR-0013-soft-deletion-and-retention.md)).

### AI does not receive custom field values by default

Custom fields are where a workspace puts whatever matters to it — which is
where the most sensitive, least predictable PII will end up ("Patient Type",
"Case Number"). No AI tool returns them. If a future tool needs one, it names it
explicitly and passes review.

### Not searchable in Stage 2.5

Making arbitrary custom fields searchable means either a join per field or a
denormalised search column, and neither should be built before a real query
pattern exists. Values are readable on a contact; they are not a filter.

## Consequences

### Positive

- Erasure can enumerate and clear custom PII, because the schema describes itself.
- Values are typed, so dates sort and numbers compare.
- Archiving preserves history.

### Negative

- A join to read values, and a second to resolve labels. Acceptable: values are
  read on a detail page, not in a list.
- Company custom fields need a second pair of tables rather than a row in an
  existing one. Accepted as the price of referential integrity.
- Five types will not cover everything. Deliberate — each new type is a
  validation, storage and rendering decision.
- Not filterable yet.

## Revisit when

- A workspace needs to filter or segment by a custom field → design the query
  path deliberately, probably a denormalised index for selected fields.
- Multi-select or file-upload types are genuinely required.

## Related

- [ADR-0020](ADR-0020-privacy-erasure.md) — why the blob was rejected
- [ADR-0013](ADR-0013-soft-deletion-and-retention.md) — archive, don't delete
