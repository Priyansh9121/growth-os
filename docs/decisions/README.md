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
