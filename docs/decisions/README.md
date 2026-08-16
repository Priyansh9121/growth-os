# Architecture Decision Records

An ADR captures **one** decision: the forces acting on it, what was chosen, what
was rejected and why, and what it costs.

## Rules

1. **One decision per record.** If a record needs "and also", split it.
2. **Immutable once `Accepted`.** Changing your mind means writing a new ADR
   that supersedes the old one. The old record stays, marked `Superseded by
ADR-NNNN`. The history of reversals is itself valuable.
3. **Record rejected alternatives.** An ADR that lists only the winner is a
   press release. The rejected options are the reason the record exists.
4. **Record the cost.** Every decision has one. An ADR with no "Consequences —
   negative" section is not finished.
5. **Date it and state the world.** "As of 2026-08 the team is one engineer" is
   context a future reader needs to judge whether the reasoning still holds.

## Status values

| Status                   | Meaning                         |
| ------------------------ | ------------------------------- |
| `Proposed`               | Under discussion                |
| `Accepted`               | In force                        |
| `Superseded by ADR-NNNN` | Replaced                        |
| `Deprecated`             | No longer applies; not replaced |

## Template

```markdown
# ADR-NNNN — Title

**Status:** Proposed | Accepted | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD
**Deciders:** …
**Context as of this date:** team size, stage, scale, constraints

## Context

The forces. What problem, what constraints, what we know and do not know.

## Decision

What we are doing. Unambiguous, present tense.

## Alternatives considered

### A — <name>

What it is · why it is attractive · **why rejected**

## Consequences

### Positive

### Negative

### Risks and mitigations

## Revisit when

The specific, observable trigger that should reopen this decision.

## Related

ADRs, docs, code.
```

## Index

| ADR                                               | Title                                                     | Status   |
| ------------------------------------------------- | --------------------------------------------------------- | -------- |
| [0001](ADR-0001-architecture-style.md)            | Architecture style: modular monolith                      | Accepted |
| [0002](ADR-0002-monorepo-and-package-strategy.md) | Monorepo with npm workspaces, TypeScript-source packages  | Accepted |
| [0003](ADR-0003-database-and-orm.md)              | PostgreSQL with Drizzle ORM                               | Accepted |
| [0004](ADR-0004-authentication.md)                | First-party session authentication                        | Accepted |
| [0005](ADR-0005-multi-tenancy-model.md)           | Workspace tenancy via memberships, with RLS backstop      | Accepted |
| [0006](ADR-0006-ui-stack.md)                      | Next.js App Router, Tailwind v4, first-party primitives   | Accepted |
| [0007](ADR-0007-3d-stack.md)                      | three.js with React Three Fiber, no helper library        | Accepted |
| [0008](ADR-0008-login-transition-architecture.md) | Persistent scene host driven by an explicit state machine | Accepted |
| [0009](ADR-0009-rate-limiting.md)                 | In-process rate limiting behind a driver interface        | Accepted |
| [0010](ADR-0010-validation-and-contracts.md)      | Zod at every trust boundary                               | Accepted |

### Stage 2 — CRM foundation

| ADR                                                    | Title                                                | Status   |
| ------------------------------------------------------ | ---------------------------------------------------- | -------- |
| [0011](ADR-0011-crm-domain-model.md)                   | Contact / Acquisition / Opportunity as the CRM spine | Accepted |
| [0012](ADR-0012-provenance-model.md)                   | Provenance with a required confidence level          | Accepted |
| [0013](ADR-0013-soft-deletion-and-retention.md)        | Soft deletion, and why it is not erasure             | Accepted |
| [0014](ADR-0014-activity-vs-audit.md)                  | Activity timeline vs. security audit log             | Accepted |
| [0015](ADR-0015-contact-identity-and-deduplication.md) | Detect duplicates, never merge automatically         | Accepted |
| [0016](ADR-0016-list-pagination-and-filtering.md)      | Keyset pagination with closed filter sets            | Accepted |
| [0017](ADR-0017-content-security-policy.md)            | Nonce-based CSP with `strict-dynamic`                | Accepted |
| [0018](ADR-0018-invitations-and-registration.md)       | Invitation-only access, no public registration       | Accepted |

### Stage 2.5 — data lifecycle and ingestion readiness

| ADR                                             | Title                                               | Status                |
| ----------------------------------------------- | --------------------------------------------------- | --------------------- |
| [0019](ADR-0019-contact-merge.md)               | Contact merge: forward-only, previewed              | Accepted              |
| [0020](ADR-0020-privacy-erasure.md)             | Erasure: anonymise in place, keep the commercials   | Accepted              |
| [0021](ADR-0021-ingestion-and-idempotency.md)   | One ingestion boundary, with idempotency receipts   | Accepted              |
| [0022](ADR-0022-custom-field-storage.md)        | Custom fields: typed definitions, relational values | Accepted              |
| [0023](ADR-0023-csv-import.md)                  | CSV import: validate all, then write in chunks      | Accepted              |
| [0024](ADR-0024-multi-factor-authentication.md) | MFA: TOTP first, passkeys next, SMS never           | Accepted, impl. gated |

### Stage 3 — lead capture and attribution ingestion

| ADR                                        | Title                                             | Status   |
| ------------------------------------------ | ------------------------------------------------- | -------- |
| [0025](ADR-0025-system-actors.md)          | System actors: capability grants without a user   | Accepted |
| [0026](ADR-0026-public-form-resolution.md) | Resolving a public form to a tenant               | Accepted |
| [0027](ADR-0027-embed-mechanism.md)        | Embed forms in an iframe, loaded by a tiny script | Accepted |
| [0028](ADR-0028-attribution-storage.md)    | Browser attribution storage: sessionStorage only  | Accepted |
| [0029](ADR-0029-web-properties.md)         | `sites`: one shared web-property model            | Accepted |
| [0030](ADR-0030-worker-and-queue.md)       | A PostgreSQL-backed worker, and no Redis yet      | Accepted |
