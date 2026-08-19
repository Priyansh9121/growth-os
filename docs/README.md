# Growth OS Documentation

This directory is the authoritative record of **what Growth OS is, why it is
built the way it is, and what we deliberately have not built yet**.

Documentation here is written _as decisions are made_, not retrofitted. If an
implementation and a document disagree, that is a bug in one of them — file it.

## How to read this

| If you are…                          | Start here                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| New to the product                   | [product/vision.md](product/vision.md) → [product/feature-map.md](product/feature-map.md)                             |
| New to the codebase                  | [engineering/repository-map.md](engineering/repository-map.md) → [architecture/overview.md](architecture/overview.md) |
| Getting it running locally           | [operations/local-development.md](operations/local-development.md)                                                    |
| Asking "why is it like this?"        | [decisions/](decisions/) (ADRs)                                                                                       |
| Reviewing security                   | [security/threat-model.md](security/threat-model.md)                                                                  |
| Building UI                          | [design/design-system.md](design/design-system.md)                                                                    |
| Asking "what exists right now?"      | [PROJECT-STATUS.md](PROJECT-STATUS.md) — measured, regenerated wholesale                                              |
| Wondering what happened in a session | [development-log/](development-log/)                                                                                  |

## Directory guide

### `PROJECT-STATUS.md`

A single-page, measured answer to _what exists, what is tested, what is still
open_. Every figure in it is produced by a command; it is **regenerated
wholesale**, never patched, so no part of it can quietly go stale while the
rest stays current.

### `product/`

The commercial and functional definition of Growth OS. Answers _what problem,
for whom, in what order_.

- [vision.md](product/vision.md) — the problem, the wedge, the loop, why now
- [product-principles.md](product/product-principles.md) — the rules we design by
- [product-roadmap.md](product/product-roadmap.md) — 23 stages, each with a definition of done
- [personas.md](product/personas.md) — who buys, who operates, who suffers
- [user-journeys.md](product/user-journeys.md) — end-to-end narratives
- [feature-map.md](product/feature-map.md) — every planned surface, and its stage
- [terminology.md](product/terminology.md) — the shared vocabulary; **read this before naming anything**

### `architecture/`

How the system is shaped and why those boundaries exist.

- [overview.md](architecture/overview.md) — the modular monolith and its seams
- [system-context.md](architecture/system-context.md) — external actors and systems
- [module-boundaries.md](architecture/module-boundaries.md) — the dependency rules, and how they are enforced
- [multi-tenancy.md](architecture/multi-tenancy.md) — platform → agency → workspace
- [crm-architecture.md](architecture/crm-architecture.md) — the CRM spine, provenance, IDOR defence
- [lead-capture-architecture.md](architecture/lead-capture-architecture.md) — how an anonymous visitor becomes an attributed lead
- [worker-architecture.md](architecture/worker-architecture.md) — background jobs, the queue, and who owns the database pool
- [data-architecture.md](architecture/data-architecture.md) — current schema and the planned domain model
- [event-architecture.md](architecture/event-architecture.md) — the future event backbone
- [ai-agent-architecture.md](architecture/ai-agent-architecture.md) — agents, tools, autonomy levels
- [voice-architecture.md](architecture/voice-architecture.md) — the boundary to the Python realtime voice service
- [security-architecture.md](architecture/security-architecture.md) — controls by layer
- [deployment-architecture.md](architecture/deployment-architecture.md) — environments and topology

### `decisions/`

Architecture Decision Records. One decision per file, immutable once accepted —
superseded rather than edited. See [decisions/README.md](decisions/README.md).

### `design/`

- [brand-direction.md](design/brand-direction.md) — what Growth OS should feel like
- [design-system.md](design/design-system.md) — tokens, scales, states
- [motion-system.md](design/motion-system.md) — duration tiers, easings, reduced motion
- [3d-system.md](design/3d-system.md) — where 3D is allowed, and where it is banned
- [login-experience.md](design/login-experience.md) — the flagship surface specification
- [accessibility.md](design/accessibility.md) — the commitments we test
- [responsive-behaviour.md](design/responsive-behaviour.md) — breakpoints and degradation
- [performance-budget.md](design/performance-budget.md) — budgets and how they are measured

### `engineering/`

- [repository-map.md](engineering/repository-map.md) — every significant directory, its boundary, its rules
- [coding-standards.md](engineering/coding-standards.md)
- [naming-conventions.md](engineering/naming-conventions.md)
- [error-handling.md](engineering/error-handling.md) — the error taxonomy and how it crosses the wire
- [logging.md](engineering/logging.md) — structured logging and the redaction rules
- [testing-strategy.md](engineering/testing-strategy.md)
- [environment-management.md](engineering/environment-management.md)
- [dependency-policy.md](engineering/dependency-policy.md) — the questions asked before `npm install`
- [gitignore-rationale.md](engineering/gitignore-rationale.md) — every ignore rule, justified

### `security/`

- [threat-model.md](security/threat-model.md)
- [authentication.md](security/authentication.md)
- [tenant-isolation.md](security/tenant-isolation.md)
- [data-lifecycle.md](security/data-lifecycle.md) — retention, erasure, and what is deliberately not scheduled
- [public-forms-threat-model.md](security/public-forms-threat-model.md) — the first endpoint reachable by anyone
- [attribution-privacy.md](security/attribution-privacy.md) — what is captured about a visitor, and what is not
- [secrets.md](security/secrets.md)
- [secure-development.md](security/secure-development.md)

### `operations/`

- [local-development.md](operations/local-development.md)
- [database.md](operations/database.md)
- [migrations.md](operations/migrations.md)
- [backup-recovery.md](operations/backup-recovery.md)
- [troubleshooting.md](operations/troubleshooting.md)

### `development-log/`

A dated, numbered record of each meaningful build session: objective, initial
state, investigation, decisions, alternatives, files touched, architecture and
security impact, testing, result, remaining work.

This is the "how we got here" narrative that ADRs deliberately omit.

## Documentation rules

1. **Documents state what is true now.** Planned work is labelled
   `PLANNED (Stage N)` and lives under a "Not yet built" heading. A reader must
   never be able to mistake a plan for an implementation.
2. **Explain why, then what.** The code already says what.
3. **Every architectural claim names its enforcement.** "Packages must not
   import apps" is worthless without the lint rule that fails the build.
4. **No fabricated numbers.** Performance figures cite the command that produced
   them. Product metrics in screenshots are labelled as fixtures.
5. **Decisions are dated and attributed to a state of the world**, so a future
   reader can tell whether the reasoning still holds.
