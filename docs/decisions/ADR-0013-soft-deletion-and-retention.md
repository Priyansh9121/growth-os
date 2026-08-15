# ADR-0013 — Deletion semantics and retention, per entity

**Status:** Accepted
**Date:** 2026-08-15

## Context

Deletion rules must be designed **before** customer data exists. Retrofitting
soft delete onto populated tables means backfilling, auditing every existing
query for a `deleted_at IS NULL` clause, and discovering the ones that were
missed in production.

"Soft delete everything" is the reflex answer and it is wrong. It makes
historical records mutable, breaks append-only guarantees, and turns a GDPR
erasure request into a search for rows that were never really deleted.

## Decision

**Deletion semantics are chosen per entity, from four options**, based on
whether the record is _identity_, _configuration_ or _history_.

| Entity            | Semantics                                              | Reason                                                                                                    |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `contacts`        | **Soft delete** (`deleted_at`, `deleted_by_user_id`)   | Identity. Recoverable; referenced by history that must not break                                          |
| `companies`       | **Soft delete**                                        | Identity, same reasoning                                                                                  |
| `opportunities`   | **Close, don't delete** (`status = lost`, `closed_at`) | A deal that did not happen is a _commercial fact_, not a mistake. Deleting it corrupts win-rate reporting |
| `tasks`           | **Cancel** (`status = cancelled`)                      | "This no longer needs doing" is a real outcome and belongs in history                                     |
| `pipelines`       | **Archive** (`archived_at`)                            | Configuration. Hiding it must not orphan the opportunities that reference it                              |
| `pipeline_stages` | **Archive** (`archived_at`)                            | As above. Deleting a stage would strand opportunities in a non-existent state                             |
| `acquisitions`    | **No deletion** through normal operation               | Immutable provenance. Removable only via the erasure path below                                           |
| `activities`      | **No deletion** through normal operation               | Append-only history. Editable history is not history                                                      |
| `audit_events`    | **Never**, enforced by the absence of an RLS policy    | Stage 1 decision, unchanged                                                                               |

### Erasure is a separate, privileged path

Soft delete is a _product_ feature ("remove this from my list"). It is **not**
GDPR erasure.

Erasure is a distinct, audited, capability-gated operation that hard-deletes or
irreversibly anonymises personal data across contacts, acquisitions and
activities. It is **not implemented in Stage 2** and is a named prerequisite
before the first real customer — recorded in
[secure-development.md](../security/secure-development.md).

Being explicit that soft delete ≠ erasure matters: a team that believes
`deleted_at` satisfies a deletion request has a compliance failure, not a bug.

### Archived and deleted records are excluded at the repository layer

Every list query excludes soft-deleted rows by default. Including them requires
an explicit, named option (`includeDeleted: true`), so it is visible in review
rather than being the accidental default.

## Alternatives considered

### A — Soft delete on every table

**Rejected:** makes `activities` and `acquisitions` mutable, destroying the
append-only property their value depends on. Also adds `deleted_at IS NULL` to
every query on tables that can never be deleted.

### B — Hard delete everywhere

**Rejected:** a mis-click destroys a customer's history irrecoverably, and
foreign keys from historical records would either cascade (losing the history
too) or block the delete.

### C — A generic `status` enum on everything

**Rejected:** conflates "archived" (configuration hidden) with "lost"
(commercial outcome) with "cancelled" (work abandoned). They report
differently, and one column cannot mean three things.

### D — Defer the decision to Stage 3

**Rejected:** this ADR exists precisely because deferring it is the expensive
option. There is no customer data today; there will be at Stage 3.

## Consequences

### Positive

- Historical and provenance data is genuinely immutable.
- Reporting can distinguish "no deal" from "deleted record".
- Erasure obligations have a defined home rather than being assumed satisfied.

### Negative

- Four different semantics to learn. Mitigated by the table above being the
  single reference, and by each schema file stating its rule.
- Soft-deleted contacts still hold PII until erasure exists — an accepted,
  documented gap for Stage 2, when no real customer data is present.

### Risks and mitigations

| Risk                                              | Mitigation                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A query forgets to exclude deleted rows           | Excluded in the shared repository helper, not per call site                                                               |
| Soft delete mistaken for erasure                  | Stated here and in the security docs; erasure is a named launch prerequisite                                              |
| Unique constraints collide with soft-deleted rows | Uniqueness is enforced by **partial** indexes with `WHERE deleted_at IS NULL`, so a deleted contact's email can be reused |

## Revisit when

- The first real customer data is loaded → erasure must exist by then.
- A customer requests restore-from-archive UI.

## Related

- [ADR-0011](ADR-0011-crm-domain-model.md)
- [security/secure-development.md](../security/secure-development.md)
