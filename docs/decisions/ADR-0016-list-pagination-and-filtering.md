# ADR-0016 — List pagination, filtering and search

**Status:** Accepted
**Date:** 2026-08-15

## Context

Every CRM list is an unbounded result set over tenant data. Getting this wrong
produces either an endpoint that returns 200,000 contacts, or a filter language
that becomes an accidental SQL injection surface.

## Decision

### 1. Keyset (cursor) pagination, not offset

Cursor is an opaque base64url string encoding the sort key plus the row `id` as
a tiebreak.

**Why keyset:** offset pagination degrades linearly — `OFFSET 50000` makes
PostgreSQL walk 50,000 rows and discard them — and it **skips and duplicates
rows** when data changes between pages, which it constantly does in a CRM
someone else is editing. Keyset is O(log n) via the index and stable under
concurrent writes.

**Why opaque:** a client that parses the cursor will depend on its shape, and we
lose the ability to change the sort. It is base64url of a small JSON object,
validated on read, and rejected if malformed — it is client-supplied input.

Page size defaults to 25 and is capped at 100. The cap is enforced server-side,
not by the client's request.

### 2. A closed set of named filters. No filter language.

Each list endpoint declares its allowed filters as a Zod schema:

| List          | Filters                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| Contacts      | `ownerUserId`, `sourceType`, `companyId`, `createdBefore/After`, `query`     |
| Opportunities | `pipelineId`, `stageId`, `ownerUserId`, `status`, `createdBefore/After`      |
| Tasks         | `assignedUserId`, `status`, `priority`, `dueBefore/After`, `scope=mine\|all` |

Anything not in the schema is rejected. A generic `filter[field][op]=value`
language would let a client name arbitrary columns, which is an authorization
bypass waiting to happen (`filter[workspace_id][ne]=...`) and makes indexing
impossible to reason about.

### 3. Search is PostgreSQL `ILIKE` on normalised columns, not full-text

Contacts search matches name, `email_normalised` and `phone_normalised`;
companies match name; opportunities match title.

**Why not `tsvector`:** full-text search is optimised for prose. CRM search is
prefix/substring matching on short identifiers — someone typing "sar" or the
last four digits of a phone number. `to_tsquery` handles neither well.

**Why not Elasticsearch:** a second datastore, a sync problem and an operational
burden for a workload PostgreSQL handles comfortably at this scale.

**Documented threshold:** revisit when a workspace exceeds ~100k contacts or
search p95 exceeds 200 ms. At that point add a `pg_trgm` GIN index before
considering a separate engine.

### 4. Sorting is a closed set too

Contacts: `createdAt`, `updatedAt`, `lastName`. Opportunities: `createdAt`,
`estimatedValue`, `expectedCloseOn`. Tasks: `dueAt`, `createdAt`, `priority`.

Every sort key is backed by an index that includes `workspace_id` as its
leading column, because every query is tenant-scoped.

## Alternatives considered

### A — Offset pagination

_Attractive:_ trivial, supports "jump to page 7".

**Rejected:** skips and duplicates rows under concurrent modification, and
degrades linearly. The page-number UI is the only real loss, and infinite-scroll
or "load more" is a better fit for a CRM list anyway.

### B — Generic filter DSL

**Rejected:** authorization bypass surface, unbounded query shapes, impossible
to index deliberately.

### C — `tsvector` full-text search now

**Rejected:** wrong tool for short-identifier matching; adds index maintenance
cost on every write for no gain at current scale.

### D — Return everything and filter client-side

**Rejected:** unbounded response, and it ships the entire tenant dataset to the
browser — a data-exposure problem as much as a performance one.

## Consequences

### Positive

- Stable, indexed pagination that does not degrade.
- The query surface is finite, so it can be indexed and reasoned about.
- No filter-language injection surface.

### Negative

- No "jump to page N". Accepted.
- Adding a filter requires a schema change — deliberate friction.
- `ILIKE '%term%'` cannot use a btree index. Acceptable at Stage 2 volumes;
  `pg_trgm` is the documented next step.

## Revisit when

- A workspace exceeds ~100k contacts, or search p95 > 200 ms → add `pg_trgm`.
- Users ask for saved views → filters become persisted objects, still from the
  closed set.

## Related

- [architecture/crm-architecture.md](../architecture/crm-architecture.md)
- [architecture/data-architecture.md](../architecture/data-architecture.md)
