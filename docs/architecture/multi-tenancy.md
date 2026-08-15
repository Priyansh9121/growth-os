# Multi-Tenancy Architecture

**Status:** Implemented (Stage 1)
**Last reviewed:** 2026-08-15
**Governing ADR:** [ADR-0005](../decisions/ADR-0005-multi-tenancy-model.md)
**Security detail:** [../security/tenant-isolation.md](../security/tenant-isolation.md)

---

## 1. The hierarchy

```
                        PLATFORM
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼─────┐      ┌─────▼────┐       ┌─────▼──────┐
   │ Workspace│      │ Workspace│       │   Agency   │
   │ (direct) │      │ (direct) │       │            │
   └──────────┘      └──────────┘       └─────┬──────┘
                                              │
                              ┌───────────────┼───────────────┐
                         ┌────▼─────┐   ┌─────▼────┐   ┌──────▼───┐
                         │ Workspace│   │ Workspace│   │ Workspace│
                         │ (client) │   │ (client) │   │ (client) │
                         └──────────┘   └──────────┘   └──────────┘
```

**The workspace is the tenancy boundary.** Every piece of customer data belongs
to exactly one workspace. An agency is an _ownership and administration_ layer
above workspaces — it is not itself a data boundary, and no customer record is
ever stored against an agency.

That distinction is deliberate. If agencies were also a data boundary we would
have two isolation models to get right instead of one, and every future tenant
table would need to answer "which boundary am I in?". Instead there is exactly
one question: _which workspace?_

## 2. Access is a graph, never a column

The single most consequential decision in the schema:

> **A user does not belong to a workspace. A membership connects them.**

```
   users ──┐
           ├── memberships ────────────▶ workspaces
           │      (role)                     │
           │                                 │ agency_id (nullable)
           └── agency_memberships ──▶ agencies
                     (role)
```

There is **no `users.workspace_id`**. Consequences:

- One user can operate 40 client workspaces (P2 Agency Strategist) with one
  identity and one session.
- A business owner can hold memberships in their own workspace and in a
  partner's.
- Agencies can be added, removed and re-parented without touching identity.

Retrofitting this later would mean rewriting every authorization path and every
query in the product. It costs one extra join now; it is not negotiable.

## 3. Two ways to reach a workspace

Access is granted by **either** a direct membership **or** an agency membership
on the workspace's owning agency:

```
canAccess(user, workspace) :=
      ∃ membership(user, workspace)
   ∨ (workspace.agency_id ≠ null ∧ ∃ agency_membership(user, workspace.agency_id))
```

Both paths are resolved once per request into an `Actor`
([`packages/auth/src/authorization/actor.ts`](../../packages/auth/src/authorization/actor.ts)),
which carries the full set of accessible workspaces and the effective role in
each. Where both paths exist, **the stronger role wins**.

Agency-derived access is marked with `via: 'agency'` on the resolved membership.
This is not cosmetic — Stage 16 requires agency access to be visibly attributed
and separately auditable, and the audit trail must be able to distinguish "the
client's own admin did this" from "their agency did this".

## 4. Roles and capabilities

Roles are a **fixed enum in code**, not rows in a table. There is no requirement
for customer-defined roles, and a database-backed permission system would add a
join to every authorization check plus a whole administration surface, for
nothing. Recorded in [ADR-0005](../decisions/ADR-0005-multi-tenancy-model.md);
revisit when a real customer needs custom roles.

### Workspace roles

| Role     | Intent                   | Notable capabilities                                              |
| -------- | ------------------------ | ----------------------------------------------------------------- |
| `owner`  | The business owner       | Everything, including deleting the workspace and managing billing |
| `admin`  | Trusted operator         | Everything except workspace deletion and billing                  |
| `member` | Day-to-day operator (P5) | Read and write operational data; no member management             |
| `viewer` | Read-only stakeholder    | Read only; explicitly cannot export                               |

### Agency roles

| Role            | Intent                                                                |
| --------------- | --------------------------------------------------------------------- |
| `agency_owner`  | Owns the agency; manages agency members and all client workspaces     |
| `agency_admin`  | Manages client workspaces; cannot manage agency membership or billing |
| `agency_member` | Operates assigned client workspaces                                   |

Capabilities use `scope:resource:action` (e.g. `workspace:members:invite`) and
are declared in one place —
[`packages/contracts/src/tenancy/capabilities.ts`](../../packages/contracts/src/tenancy/capabilities.ts).
A capability is granted only if it appears in the role's set; the lookup is
total, so a missing entry denies rather than throws or defaults open.

## 5. Isolation: three independent layers

Cross-tenant exposure is the bug class that ends the company (Principle 5), so
one layer is not enough. Each layer below assumes the others may fail.

### Layer 1 — Application

Every request resolves an `Actor` and calls `requireWorkspaceAccess(actor,
workspaceId, capability)` **before** any data access. It raises
`AuthorizationError` (HTTP 403, generic body) when access is absent.

### Layer 2 — Service / query scoping

Tenant-scoped data access runs inside `withTenantTransaction(workspaceId, fn)`,
which opens a transaction and issues `SET LOCAL app.workspace_id = <id>`.
`SET LOCAL` is transaction-scoped, so a pooled connection cannot leak the
setting into the next request — a real failure mode with connection pooling that
a naive `SET` would introduce.

### Layer 3 — Database row-level security

Tenant tables carry RLS policies that filter on
`current_setting('app.workspace_id')`. If application code forgets a
`WHERE workspace_id = …`, the database returns zero rows rather than another
tenant's data.

**Critical operational requirement:** PostgreSQL exempts superusers and table
owners from RLS. The application role must therefore be a **non-owner,
non-superuser** role in any shared environment, or Layer 3 is silently inert.
This is verified by migration `0001_tenant_rls.sql` and asserted by an
integration test that connects as the restricted role. See
[../security/tenant-isolation.md](../security/tenant-isolation.md).

### What each layer catches

| Failure                                            | L1  | L2  | L3                                                     |
| -------------------------------------------------- | --- | --- | ------------------------------------------------------ |
| Missing authorization check in a new endpoint      | ✗   | ✗   | ✅                                                     |
| Forgotten `WHERE workspace_id` in a query          | ✗   | —   | ✅                                                     |
| IDOR via a guessed/enumerated ID                   | ✅  | —   | ✅                                                     |
| Compromised session used against another workspace | ✅  | —   | ✅                                                     |
| SQL injection reaching the tenant tables           | ✗   | ✗   | ✅ (still scoped)                                      |
| Application role misconfigured as table owner      | ✗   | ✗   | ✗ ⚠️ — covered by test + migration, not by the runtime |

## 6. The active workspace

A session is **not** bound to a workspace. Users switch workspaces without
re-authenticating; the session identifies _who_, and the request identifies
_where_.

The active workspace is resolved per request in this order:

1. An explicit `workspaceId` in the request (route param or body).
2. The `gos_workspace` cookie (a UX preference, **never** a grant).
3. The user's first accessible workspace, deterministically ordered.

**The cookie is a hint, not authority.** Its value is always validated against
the actor's resolved memberships before use. A user who edits it to another
workspace's ID receives 403 — and is denied by RLS underneath even if the check
were missed.

## 7. Onboarding shapes

| Shape                      | Result                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| Direct business signs up   | 1 user, 1 workspace (`agency_id = null`), membership `owner`              |
| Agency signs up            | 1 user, 1 agency, agency membership `agency_owner`, 0 workspaces          |
| Agency adds a client       | 1 workspace with `agency_id` set; agency members gain access transitively |
| Agency hands a client over | `agency_id` set to null; direct memberships are unaffected                |

The last row is why agency access is transitive rather than copied into
`memberships` rows: detaching a client is a single column update, not a
migration of permission rows that could be partially applied.

## 8. Not built yet

- **Invitations** — schema designed in [data-architecture.md](data-architecture.md); flow at Stage 2.
- **Agency console** — Stage 16.
- **Per-workspace entitlements** — Stage 18; enforcement will sit at the
  capability layer so features do not each invent their own gate.
- **Workspace deletion / data export** — Stage 2. Required for GDPR-style
  obligations; deliberately not improvised.
- **Cross-workspace platform support tooling** — must be an explicit, audited,
  time-boxed elevation. There is no ambient cross-tenant query path today and
  none should be added casually.
