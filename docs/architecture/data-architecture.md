# Data Architecture

**Status:** Stage 1 schema implemented. Future domains documented, **not built**.
**Governing ADRs:** [0003](../decisions/ADR-0003-database-and-orm.md), [0005](../decisions/ADR-0005-multi-tenancy-model.md)

## Principles

1. **`workspace_id` is the tenancy column.** Every tenant table has it, indexed,
   with RLS policies. Never `tenant_id`.
2. **Identity is not tenant-scoped.** `users` and `sessions` are global; access
   comes from `memberships`.
3. **Timestamps over booleans.** `disabled_at` beats `is_disabled` — it records
   _when_, which you always end up needing.
4. **Foreign keys are real**, with deliberate `ON DELETE` semantics.
5. **Migrations are reviewed SQL**, immutable once merged.
6. **Provenance travels with data.** Every metric records where it came from,
   so the UI cannot present a fixture as a measurement.

## Current schema (7 tables)

```
users ──┬── sessions
        ├── memberships ──────────▶ workspaces ──▶ agencies
        ├── agency_memberships ───▶ agencies         ▲
        └── audit_events ─────────▶ workspaces ──────┘ (agency_id, nullable)
```

| Table                | Purpose                                   | Tenant-scoped?         |
| -------------------- | ----------------------------------------- | ---------------------- |
| `users`              | Platform-global identity                  | no                     |
| `sessions`           | Opaque tokens, stored hashed              | no                     |
| `agencies`           | Reseller organisations                    | no                     |
| `workspaces`         | **The tenancy boundary**                  | is the boundary        |
| `memberships`        | user ↔ workspace, with role               | no (defines access)    |
| `agency_memberships` | user ↔ agency, granting transitive access | no                     |
| `audit_events`       | Append-only trail                         | **yes — RLS enforced** |

### Decisions worth knowing

- **`workspaces.agency_id` is `ON DELETE SET NULL`**, not cascade. Deleting an
  agency must not destroy its clients' data — the workspaces survive as direct
  businesses, which is also exactly what handing a client back requires.
- **`audit_events.actor_user_id` is `ON DELETE SET NULL`.** The record must
  survive the deletion of the user it describes, or deleting an account erases
  the evidence of what that account did.
- **`memberships` has a composite unique on `(user_id, workspace_id)`.**
  Without it a user could hold two roles in one workspace and "which applies?"
  becomes order-dependent — a silent authorization bug.
- **Roles are native PostgreSQL enums generated from the TypeScript constant**,
  so the database and the capability matrix cannot drift.
- **`workspaces.timezone` exists from day one.** Appointments (Stage 11) and
  daily rollups are wrong without it, and backfilling a timezone is guesswork.

## Planned domain model — NOT BUILT

Documented so the shape is agreed before it is needed, and so the tenancy
pattern is applied uniformly. Every table below gets `workspace_id`, an index
and RLS.

**SEO (Stages 3–8):** `sites`, `crawls`, `crawl_pages`, `seo_findings`,
`keywords`, `rankings`, `competitors`, `content_items`,
`internal_link_opportunities`.

**Local (Stage 9):** `business_profiles`, `reviews`, `local_rankings`.

**CRM (Stage 2):** `contacts`, `companies`, `leads`, `pipelines`,
`pipeline_stages`, `deal_opportunities`, `activities`, `tasks`.
_Note the name:_ `deal_opportunities`, never bare `opportunities` — it collides
with the growth-loop concept ([terminology](../product/terminology.md)).

**Voice (Stage 13):** `voice_agents`, `phone_numbers`, `calls`, `call_events`,
`call_summaries`. Recordings are regulated personal data with retention rules.

**Automation (Stage 12):** `workflows`, `workflow_versions` (**immutable** — a
run must be interpretable against the version that produced it), `workflow_runs`,
`workflow_steps`.

**Calendar (Stage 11):** `calendars`, `availability_rules`, `appointments`.
Booking requires a serialisable transaction; two concurrent attempts on one
slot must yield exactly one appointment.

**Analytics (Stage 15):** `events`, `conversions`, `revenue_events`,
`attribution_records`. High volume — the first candidates for partitioning.

**Billing (Stage 18):** `plans`, `subscriptions`, `feature_entitlements`,
`usage_records`.

## The attribution join — the reason for one database

```sql
keywords → rankings → sessions → conversions → leads
         → deal_opportunities → revenue_events → attribution_records
```

This traversal is the product's differentiator. Splitting these across services
would replace a `JOIN` with a distributed consistency problem — the core
argument of [ADR-0001](../decisions/ADR-0001-architecture-style.md).

## Scale plan

Not needed yet, but the shape is known: partition `events` and `rankings` by
month; read replicas for reporting; aggregate rollup tables for dashboards;
archive crawl bodies to object storage. All Stage 22.
