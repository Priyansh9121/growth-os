# ADR-0025 — System actors: capability grants without a user

**Status:** Accepted
**Date:** 2026-08-16

## Context

Stage 3 introduces the product's first **anonymous public write path**. A
website visitor submits a form; nobody is signed in; a CRM lead must appear.

Auditing `ingestAcquisition` before building on it found that the CRM execution
context assumes a human throughout:

```ts
requireCapability(context, 'workspace:crm:contacts:write');
// → workspaceRoleHasCapability(context.tenant.workspace.role, capability)

createdByUserId: actorUserId(context),
// → context.tenant.actor.userId, a NOT-NULL-able FK to users.id
```

Both assumptions break for a public submission, and they break differently:

- **The capability check** would need a workspace _role_. The weakest role that
  holds `contacts:write` is `member` — which also holds `opportunities:write`,
  `tasks:write`, `companies:write` and `tags:apply`. Handing a public endpoint a
  `member` role grants it five capabilities to use one.
- **`createdByUserId`** would need a user id. There is none. A fabricated UUID
  violates the foreign key; a real one is a lie about who acted.

## Decision

### 1. A system grant is an explicit capability list, not a role

```ts
export interface SystemGrant {
  /** Opaque, for audit. e.g. `public_form:<formId>`. Never PII. */
  readonly label: string;
  readonly capabilities: readonly Capability[];
}
```

`CrmContext` gains an optional `system` field. When it is present,
`requireCapability` consults the grant **instead of** the role.

The public form path is granted exactly `['workspace:crm:contacts:write']`.
Nothing else. If a bug ever routed a public submission into `eraseContact`, the
capability check refuses it — which is a materially different property from
"the code happens not to call that function".

### 2. `actorUserId` THROWS on a system context

Not returns null, not returns a sentinel: **throws**.

```ts
actorUserId(context); // throws when context.system is set
actorUserIdOrNull(context); // returns null when context.system is set
```

The three ingestion write sites use the null-safe accessor and record
`created_by_user_id = NULL`, which is honest: no user created this row.

Throwing is the point. Any service reached from a system context that has not
been made system-aware fails **loudly at the call**, rather than silently
writing a fabricated foreign key or attributing a row to whoever happens to be
in the sentinel. A system path that reaches unreviewed code should stop, not
improvise.

### 3. The system context still carries a real workspace, and the weakest role

Tenancy is unchanged. The system context runs inside `withTenantTransaction`
with a real `workspace_id`, so RLS applies exactly as it does for a human — the
grant governs _capability_, never _isolation_.

The `WorkspaceAccess.role` on a system context is set to `viewer`, the weakest
role, and never consulted. If the grant branch were ever removed, the fallback
would be the least-privileged role rather than the most — a fail-safe default
rather than a fail-open one.

### 4. `actorType` is `system` in the audit trail

`AccessPath` already admitted `'system'` at the audit writer; the actor model
did not. Public ingestion writes audit records with `accessPath: 'system'` and
a null actor user, so "a form did this" is distinguishable from "an operator
did this" forever.

**No fake human user row is created.** A `system@growth-os` user in the `users`
table would appear in member lists, could be invited, could be assigned
contacts, and would make every audit record ambiguous.

## Alternatives considered

**Give the public path a `member` role.** Four unnecessary capabilities, and
the check would pass for operations the path must never perform. Rejected.

**Add a `system` workspace role to the capability matrix.** Pollutes the role
enum, which is a user-facing concept — it would appear in role pickers and
invitation forms unless every one of them special-cased it. A grant is not a
role and should not be modelled as one.

**Create a per-workspace system user row.** Explicitly rejected: it is a fake
human, and every audit record involving it becomes a question rather than an
answer.

**Make `actorUserId` return null for system contexts.** Tempting and quieter.
Rejected because it makes every existing call site silently system-compatible
without anyone checking whether it actually is — the failure would surface as a
NULL in a column somebody assumed was populated, months later.

## Consequences

### Positive

- Public ingestion holds exactly one capability, provable by test.
- A system-unaware service fails loudly rather than writing bad data.
- Audit distinguishes automated ingestion from operator action permanently.
- Tenant isolation is untouched: RLS still governs every statement.

### Negative

- Two accessors where there was one, and a rule about which to use. Mitigated
  by the throwing variant: using the wrong one is not a subtle bug.
- `requireCapability` has two branches, so the authorization path is slightly
  less uniform than it was.

## Revisit when

- A second system path appears (voice, webhooks) — confirm one grant shape fits.
- A system path legitimately needs more than one capability.

## Related

- [ADR-0005](ADR-0005-multi-tenancy-model.md) · [ADR-0021](ADR-0021-ingestion-and-idempotency.md)
- [ADR-0026](ADR-0026-public-form-resolution.md) — how the workspace is resolved
