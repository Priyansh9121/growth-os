# ADR-0014 — Activity timeline and audit trail are separate systems

**Status:** Accepted
**Date:** 2026-08-15

## Context

Both record "something happened". The temptation to use one table is strong and
the consequences of giving in are permanent.

## Decision

**Two tables, two purposes, two audiences.** One user action may emit both.

|                     | `activities` (CRM)                                  | `audit_events` (security)                                |
| ------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| **Question**        | _What happened with this customer?_                 | _Who did what to our data?_                              |
| **Audience**        | The business operator                               | Security, compliance, support, the agency's client       |
| **Example**         | "Lead created — Organic Search, /emergency-plumber" | "User X changed Contact Y's email from … to …"           |
| **Scope**           | Always workspace-scoped                             | Workspace **or platform** (a failed login has no tenant) |
| **Read capability** | `workspace:crm:activities:read` — everyday          | `workspace:audit:read` — admin only                      |
| **Contains PII**    | Yes, deliberately — it is about a person            | **No.** Identifiers only                                 |
| **Retention**       | Long; part of the customer record                   | Policy-driven, security-led                              |
| **Deletion**        | None in normal operation                            | Never, enforced by absent RLS policy                     |

### Example: one action, two records

Moving an opportunity from _Qualified_ to _Quote_ writes, in **one
transaction**:

```
activities:   { type: 'opportunity.stage_changed',
                summary: 'Qualified → Quote', occurredAt, actorType: 'user' }

audit_events: { eventName: 'crm.opportunity.stage_changed',
                targetType: 'opportunity', targetId, accessPath: 'agency' }
```

The activity is what the operator reads on the timeline. The audit event is
what answers _"the agency moved our deal — who and when?"_ six months later.

### Both are written by application services only

Never by a route handler, never from client input. A client may request an
action; the service decides what actually happened and records it. Client-authored
timeline entries would be unauthenticated claims about history.

## Alternatives considered

### A — One `events` table with a `category` column

_Attractive:_ one writer, one schema, one timeline query.

**Rejected:** the two have incompatible requirements. Audit must be readable by
admins only and must contain no PII; activity must be readable by every
operator and is _made of_ PII. One table means either operators can read the
security log, or admins must filter to see the customer timeline. It also
forces one retention policy onto two different legal obligations.

### B — Derive the activity timeline from audit events

_Attractive:_ no duplication; audit is already append-only.

**Rejected:** audit events are deliberately PII-free, so the timeline would
show "contact updated" with no idea which contact or what changed. Adding the
PII back to make it useful destroys the property that makes audit safe to
retain and expose.

### C — Activities only, no audit for CRM changes

**Rejected:** activities are business-shaped and workspace-readable. They cannot
answer "did the agency change this?" — which is a direct requirement of the
agency channel, and the reason `accessPath` exists on audit events.

## Consequences

### Positive

- Operators get a rich, PII-bearing timeline; auditors get a PII-free record.
- Different retention policies can apply to different legal obligations.
- Agency-performed actions remain distinguishable from the client's own.

### Negative

- Two writes per significant action. Both occur in **one transaction**, so they
  cannot diverge.
- Developers must decide which to write. Guidance: _did customer-relevant
  business happen?_ → activity. _did someone change data?_ → audit. Often both.

### Risks and mitigations

| Risk                           | Mitigation                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| PII drifts into audit metadata | Centralised redaction in `writeAuditEvent`; audit records identifiers only |
| Timeline and audit disagree    | Written in one transaction                                                 |
| Developers write only one      | Emitted together inside the service, not left to call sites                |

## Related

- [ADR-0011](ADR-0011-crm-domain-model.md)
- [architecture/crm-architecture.md](../architecture/crm-architecture.md)
- [engineering/logging.md](../engineering/logging.md)
