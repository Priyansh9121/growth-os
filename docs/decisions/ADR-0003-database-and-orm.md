# ADR-0003 — PostgreSQL with Drizzle ORM

**Status:** Accepted
**Date:** 2026-08-15
**Context as of this date:** Zero customer data. Schema will change constantly
for the next several stages. Tenant isolation is the highest-stakes correctness
requirement in the system.

## Context

Two decisions, taken together because the second depends on the first.

**Datastore requirements**

- Relational integrity across the attribution chain (the join is the product).
- Transactions spanning multiple domains (book an appointment, create the lead,
  write the audit event, atomically).
- **Row-level security**, because it is the only isolation layer that survives
  application-code mistakes.
- Time-series-ish volume later (rankings, events) without needing a second
  datastore immediately.
- JSON for semi-structured payloads (crawl metadata, agent traces, webhooks).
- Full-text search adequate for in-app search without adding Elasticsearch.

**Data-access-layer requirements**

- Type safety that reflects the _actual_ schema, including nullability.
- Ability to express the RLS pattern: `SET LOCAL` inside a transaction, on the
  same connection.
- Migrations that are reviewable SQL — a security control, since an RLS policy
  change must be visible in a pull request diff.
- No runtime component that obscures the emitted SQL.

## Decision

**PostgreSQL 16+** as the sole datastore for the foreseeable future.

**Drizzle ORM** as the data access layer, with **drizzle-kit** generating plain
SQL migrations, and `postgres` (postgres.js) as the driver.

Specific consequences adopted now:

- Schema is defined in TypeScript in
  [`packages/database/src/schema`](../../packages/database/src/schema) and is
  the single source of truth for both types and migrations.
- Migrations are **generated then reviewed as SQL**, and hand-written where
  generation cannot express the intent (RLS policies, partial indexes,
  constraint triggers). Migration files are immutable once merged.
- All tenant-scoped access goes through `withTenantTransaction()`, which issues
  `SET LOCAL app.workspace_id` — transaction-scoped so a pooled connection
  cannot leak the value to the next request.

## Alternatives considered

### Datastore

#### A — PostgreSQL (chosen)

Everything above, plus RLS, which is decisive. No other option in this class
offers a database-enforced tenancy backstop of comparable maturity.

#### B — MySQL / PlanetScale

_Attractive because:_ excellent horizontal scaling story and branching
workflows.

**Rejected because:** no row-level security, which removes our third isolation
layer entirely; historically weaker JSON and full-text capabilities; and
PlanetScale's (historic) foreign-key constraints conflict with a design that
leans on referential integrity for the attribution join.

#### C — MongoDB

**Rejected because:** the core product query is a multi-way join across domains
with strict consistency requirements. This is the canonical case _against_ a
document store. Tenant isolation would also become entirely application-level.

#### D — SQLite / Turso

_Attractive because:_ trivial local development, very low latency.

**Rejected because:** concurrent write throughput and the absence of RLS. Fine
for a prototype; wrong for multi-tenant customer data.

### ORM / data layer

#### E — Drizzle (chosen)

_Why:_ SQL-shaped API, so the emitted query is predictable and reviewable; no
separate query engine or generated client binary; migrations are plain `.sql`
files; excellent inference including nullability; transactions expose the raw
connection, which is what the `SET LOCAL` pattern needs; and it runs anywhere
Node runs, including inside Next.js server components without a bundler
workaround.

_Cost:_ smaller ecosystem than Prisma, a younger project, and pre-1.0 versioning
(0.45.x at time of writing) implying breaking changes between minors. Accepted
consciously — mitigated by pinning and by the data layer being confined to one
package.

#### F — Prisma

_Attractive because:_ the most mature TypeScript ORM, superb DX, excellent
migration tooling and a large ecosystem.

**Rejected because:**

- The generated client is a build artefact that must be regenerated and kept in
  sync; it complicates a monorepo that otherwise consumes TypeScript source
  directly (see [ADR-0002](ADR-0002-monorepo-and-package-strategy.md)).
- Executing `SET LOCAL` on the same pooled connection as the subsequent queries
  requires `$transaction` with raw statements, and the interaction with Prisma's
  connection management makes the RLS pattern more fragile than it is in
  Drizzle. When the mechanism protecting tenant data is fragile, that is
  disqualifying.
- Historically heavier runtime footprint and a query engine that sits between
  the code and the SQL, which makes reviewing a security-relevant query harder.

This is a close call and Prisma would be a defensible choice for a product
without the RLS requirement. Ours has it.

#### G — Kysely

_Attractive because:_ excellent type-safe query builder, very close to SQL.

**Rejected because:** no schema definition or migration generation — we would
hand-write every migration and maintain types separately, doubling the places
the schema is expressed. Drizzle gives the same SQL-shaped ergonomics with
schema-derived types.

#### H — Raw SQL with a thin mapper

**Rejected because:** the type safety of the tenancy layer is a correctness
control, not a convenience. Hand-mapping rows to types is exactly where
`workspace_id` gets dropped.

## Consequences

### Positive

- Emitted SQL is predictable and reviewable — important when the query _is_ the
  security control.
- Migrations are readable SQL artefacts in the diff, so an RLS policy change
  cannot slip through review as an opaque schema delta.
- Types derive from one schema definition; there is no second source of truth.
- No code generation step in the development loop.

### Negative

- Drizzle is pre-1.0: minor releases may break. **Mitigation:** exact-range
  pinning, upgrades performed deliberately with the full test suite, and all
  Drizzle usage confined to `@growth-os/database` so a breaking change has one
  blast radius.
- Fewer community answers than Prisma.
- `drizzle-kit` occasionally generates a migration that needs hand-editing
  (notably around enums and constraints). **Mitigation:** every generated
  migration is read before merge — which is the policy anyway.

### Risks and mitigations

| Risk                                                    | Mitigation                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| RLS silently inert because the app role owns the tables | Documented in [tenant-isolation.md](../security/tenant-isolation.md); asserted by an integration test that connects as the restricted role |
| A future tenant table ships without an RLS policy       | Checklist in the same document; the schema review gate names it explicitly                                                                 |
| Drizzle breaking change blocks an upgrade               | Data layer isolated in one package; SQL migrations remain valid regardless of ORM                                                          |

## Revisit when

- Event/ranking volume requires partitioning or a purpose-built time-series
  store (expected around Stage 15–22).
- Drizzle reaches 1.0 (re-evaluate pinning strategy) or is abandoned.
- A workload appears that genuinely needs a second datastore — full-text search
  at a scale PostgreSQL cannot serve, or a vector store for AI retrieval.

## Related

- [architecture/data-architecture.md](../architecture/data-architecture.md)
- [security/tenant-isolation.md](../security/tenant-isolation.md)
- [operations/migrations.md](../operations/migrations.md)
