# ADR-0005 — Workspace tenancy via memberships, with an RLS backstop

**Status:** Accepted
**Date:** 2026-08-15
**Context as of this date:** No customer data yet — the cheapest possible moment
to get this right, and the last one.

## Context

Growth OS serves direct businesses _and_ agencies with client portfolios. One
user must be able to operate many workspaces. Cross-tenant data exposure is
identified in [product-principles.md](../product/product-principles.md) as the
failure that ends the company.

Three sub-decisions: the isolation strategy, the access model, and the
permission model.

## Decision

### 1. Shared database, shared schema, `workspace_id` on every tenant table

Isolation is enforced by a `workspace_id` column plus PostgreSQL **row-level
security**, not by separate databases or schemas.

### 2. Access via `memberships`, never a column on `users`

There is **no `users.workspace_id`**. A user reaches a workspace by:

- a direct row in `memberships`, or
- a row in `agency_memberships` for the agency owning that workspace
  (`workspaces.agency_id`).

Where both exist, the stronger role wins. Agency-derived access is tagged
`via: 'agency'` so it can be audited distinctly.

### 3. Roles are a code-level enum; capabilities are a static matrix

`owner | admin | member | viewer` for workspaces, `agency_owner | agency_admin |
agency_member` for agencies. Capabilities (`scope:resource:action`) map from
roles in [`packages/contracts/src/tenancy/capabilities.ts`](../../packages/contracts/src/tenancy/capabilities.ts).
No database-backed permission system.

### 4. Sessions are workspace-agnostic

A session identifies a user. The active workspace is a per-request concern,
resolved from an explicit parameter, then a cookie _hint_, then a deterministic
default — and always re-validated against the actor's memberships.

## Alternatives considered

### Isolation strategy

#### A — Database per tenant

_Attractive because:_ the strongest possible isolation; simple per-customer
backup, restore and deletion; a compliance story that sells itself.

**Rejected because:** migrations must run across N databases with partial-failure
handling; connection pooling across thousands of databases is its own
engineering project; and **cross-workspace queries become impossible** — which
kills the agency portfolio view (Stage 16), a core requirement of the primary
distribution channel. Reconsider only for a specific enterprise segment that
pays for it.

#### B — Schema per tenant

**Rejected because:** it carries most of database-per-tenant's migration pain
with a weaker isolation guarantee, and PostgreSQL performance degrades with
very large numbers of schemas.

#### C — Shared schema, application-level filtering only

**Rejected because:** it makes every `WHERE workspace_id = ?` a security
control. One forgotten clause in one query, forever, is a breach. This is the
industry's most common multi-tenant failure and it is entirely preventable.

#### D — Shared schema + RLS (chosen)

Application filtering _and_ a database-enforced backstop. A forgotten `WHERE`
returns zero rows instead of another tenant's data.

_Cost:_ every tenant-scoped query must run inside `withTenantTransaction`; the
application role must not own the tables or be a superuser (PostgreSQL exempts
both from RLS); a small per-transaction overhead.

### Access model

#### E — `users.workspace_id` (single workspace per user)

_Attractive because:_ one fewer join everywhere; simpler mental model.

**Rejected because:** it makes the agency channel unbuildable. P2 would need one
account per client. Retrofitting memberships later means rewriting every
authorization path and every query in the product. The extra join is the
cheapest insurance in this document.

#### F — Copy agency access into `memberships` rows

_Attractive because:_ one uniform access path; no transitive resolution.

**Rejected because:** every agency membership change would fan out into N
workspace rows, with partial-failure risk, and detaching a client from an agency
becomes a data migration rather than a single nullable column update.

### Permission model

#### G — Database-backed roles and permissions (RBAC tables)

_Attractive because:_ customer-defined roles without a deploy.

**Rejected because:** no customer has asked, none exists, and it adds a join to
every authorization check plus an entire administration surface. A static matrix
is faster, exhaustively type-checked, and trivially testable. Migrating to
dynamic roles later is contained because all checks go through one function.

#### H — Attribute-based access control (ABAC)

**Rejected as premature.** Revisit if record-level ownership rules appear (e.g.
"a member may only see leads assigned to them").

## Consequences

### Positive

- One user, one identity, many workspaces — the agency channel works natively.
- A forgotten `WHERE` clause is not a breach.
- Cross-workspace rollups remain possible for the agency console.
- Authorization decisions are exhaustively typed; `noUncheckedIndexedAccess`
  makes a missing capability entry a compile error rather than a silent allow.

### Negative

- Every tenant-scoped query must run inside a tenant transaction. This is a
  discipline that must be maintained as the schema grows — the checklist lives
  in [tenant-isolation.md](../security/tenant-isolation.md).
- RLS is silently inert if the application role owns the tables. This is the
  single most dangerous operational footgun in the design, so it is asserted by
  an integration test rather than trusted to documentation.
- Noisy-neighbour effects are shared-fate until Stage 22.

### Risks and mitigations

| Risk                                    | Mitigation                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| New tenant table ships without RLS      | Schema review checklist; the pattern is demonstrated on `audit_events` from day one so there is a template to copy |
| Deployment misconfigures the DB role    | Integration test connects as the restricted role and asserts isolation; documented in `operations/database.md`     |
| Agency access grants more than intended | Agency-derived access is tagged and audited separately; Stage 16 adds explicit per-client scoping within an agency |

## Revisit when

- An enterprise customer requires physical data separation → per-tenant database
  for that segment only.
- Record-level permissions are needed → evaluate ABAC.
- Customer-defined roles are requested by a paying customer → move the matrix
  into the database behind the existing `hasCapability` interface.

## Related

- [architecture/multi-tenancy.md](../architecture/multi-tenancy.md)
- [security/tenant-isolation.md](../security/tenant-isolation.md)
