# ADR-0001 — Architecture style: modular monolith

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Founding engineering
**Context as of this date:** Pre-revenue, no users, team of one. Target
customers are local service SMBs and the agencies serving them. The product
spans SEO, CRM, voice, automation and attribution.

## Context

Growth OS's scope is unusually broad for an early product: it deliberately spans
domains that are normally separate products. That breadth creates a pull toward
service-oriented decomposition — "SEO service", "CRM service", "voice service" —
because the domains _sound_ independent.

They are not independent. The product's entire differentiator is **the join**:

```
keyword → page → session → enquiry → conversation → appointment → deal → revenue
```

Answering "which keyword produced revenue?" requires traversing every one of
those domains in a single consistent read.

Three forces dominate:

1. **Iteration speed is the top risk.** We do not know the exact shape of the
   attribution model, the opportunity ranking, or the agent's tool surface.
   Every one of those will change repeatedly, and each change cuts across
   domains.
2. **The core query is relational and transactional.** Attribution is a join
   over data that must be mutually consistent.
3. **Two workloads genuinely differ** in runtime profile and blast radius: web
   crawling (bursty, IO-heavy, and a live SSRF risk that wants network
   isolation) and realtime voice (Python, latency-critical, third-party
   telephony).

## Decision

Growth OS is a **modular monolith**:

- Domain logic lives in `packages/*` — framework-agnostic, transport-agnostic,
  with **explicit, lint-enforced dependency edges**.
- `apps/*` are thin runtime hosts. They own HTTP, rendering and scheduling; they
  own no business rules.
- One database, one schema, real foreign keys, real transactions.
- A new runtime host is created only when a workload's profile or blast radius
  genuinely differs — not because a domain sounds separable.

Two extractions are pre-committed because their justification already exists:

| Extraction    | Stage | Reason                                                                                          |
| ------------- | ----- | ----------------------------------------------------------------------------------------------- |
| `apps/worker` | 3     | Crawling is bursty and IO-heavy; SSRF containment wants a separately network-restricted runtime |
| `apps/voice`  | 13    | Python, realtime, different runtime and scaling profile                                         |

## Alternatives considered

### A — Microservices from day one

Separate services for SEO, CRM, voice, automation, billing.

_Attractive because:_ independent scaling and deployment; forces boundary
discipline; matches how the domains are marketed.

**Rejected because:** it converts the product's core query into a distributed
join across service boundaries, and its core invariant (attribution consistency)
into eventual consistency with reconciliation. It taxes exactly the activity we
need most — cross-domain change — at exactly the moment we can least afford it.
With one engineer it also multiplies operational surface (deployments,
observability, contract versioning, local development) with no offsetting
benefit at zero users. Boundary discipline is achievable with lint rules; the
distributed-systems tax is not avoidable once paid.

### B — Single Next.js application with no package boundaries

All code in `apps/web/src`, organised by folders.

_Attractive because:_ fastest possible start; no workspace tooling; no
cross-package resolution issues.

**Rejected because:** folder conventions do not survive contact with deadlines.
Without a mechanical boundary, `apps/web/src/lib` accumulates business logic
coupled to React and Next primitives, and the later extraction of the worker and
voice hosts becomes a rewrite rather than a re-import. The cost of package
boundaries is a few configuration files; the cost of not having them is paid at
Stage 3.

### C — Serverless functions per capability

_Attractive because:_ scales to zero; low idle cost.

**Rejected because:** cold starts hurt an operator surface opened dozens of
times daily; crawls and voice sessions are long-running and fit the model badly;
connection pooling against PostgreSQL becomes an architectural problem requiring
an external pooler; and local development fidelity drops sharply.

### D — Event-sourced core

_Attractive because:_ attribution is genuinely a temporal, event-shaped problem,
and full history would be a real asset.

**Rejected because:** we cannot yet name the events correctly. Event sourcing
punishes an unstable domain model — the events are the schema, and renaming them
is a migration of history. We adopt the useful half now (append-only
`audit_events`, and a planned transactional outbox in
[event-architecture.md](../architecture/event-architecture.md)) without
committing to the whole pattern.

## Consequences

### Positive

- Cross-domain changes are one commit, one migration, one deploy.
- The attribution join is a SQL join with real referential integrity.
- One place to enforce tenancy, authorization and audit — three layers of
  isolation are tractable in one process.
- Local development is `npm run dev` plus a PostgreSQL instance.

### Negative

- **One deployment unit**: a bad deploy affects everything. Mitigated by CI
  gates, and later by health checks and progressive rollout.
- **Shared resource contention**: a heavy crawl could starve web requests. This
  is precisely why `apps/worker` is pre-committed at Stage 3, before crawling
  exists.
- **Boundary erosion is possible.** Mitigated mechanically by
  `eslint-plugin-boundaries`; a violation fails CI.
- **Scaling is coarse** — the whole app scales together until extraction.

### Risks and mitigations

| Risk                                           | Mitigation                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The monolith becomes a ball of mud             | Lint-enforced package edges; ADR required to add an edge                                             |
| Domain packages accidentally depend on Next.js | `packages/*` may not import `apps/*` or `next` (lint rule); domain packages have no React dependency |
| "We'll extract it later" never happens         | Two extractions are pre-committed to specific roadmap stages with named triggers                     |
| A single database becomes the bottleneck       | Read replicas and partitioning of high-volume event tables at Stage 22, before it becomes urgent     |

## Revisit when

Any one of:

- A single domain's write volume requires independent scaling (concretely:
  crawl or event ingestion exceeding what one PostgreSQL primary handles
  comfortably).
- Team size exceeds ~8 engineers and merge contention becomes measurable.
- A compliance requirement demands physical data separation for a customer
  segment.

## Related

- [architecture/overview.md](../architecture/overview.md)
- [architecture/module-boundaries.md](../architecture/module-boundaries.md)
- [ADR-0002](ADR-0002-monorepo-and-package-strategy.md)
