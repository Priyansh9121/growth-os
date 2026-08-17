# Development Log

A dated, numbered record of each meaningful build session.

## Why this exists, separately from ADRs

An ADR records **a decision**: the forces, the choice, the rejected
alternatives. It deliberately omits the journey.

This log records **the journey**: what was investigated, what was tried and
abandoned, what broke, what a test caught, and what remains. It is the
narrative a future engineer needs to answer _"why is this the way it is?"_ when
the answer is not a clean decision but a discovery.

The most valuable entries are the ones recording **failures** — a lint plugin
that silently enforced nothing, a `.gitignore` rule that would have hidden
source code. Those are precisely the things nobody writes down and everybody
rediscovers.

## Format

Each entry covers: objective · initial state · investigation · decisions ·
alternatives considered · files created and modified · architecture impact ·
security impact · testing · result · remaining work.

Entries record **engineering reasoning and evidence** — not private thought
process. Where a number appears, the command that produced it appears too.

## Entries

| #                                                        | Title                                            | Date       |
| -------------------------------------------------------- | ------------------------------------------------ | ---------- |
| [0001](0001-project-foundation.md)                       | Project foundation and toolchain                 | 2026-08-15 |
| [0002](0002-strategy-and-architecture.md)                | Product strategy, architecture and ADRs          | 2026-08-15 |
| [0003](0003-authentication-and-tenancy.md)               | Database, authentication and multi-tenancy       | 2026-08-15 |
| [0004](0004-design-system-and-login.md)                  | Design system, 3D login and the transition       | 2026-08-15 |
| [0005](0005-verification-and-measurement.md)             | Verification, measurement and hardening          | 2026-08-15 |
| [0006](0006-crm-domain-and-schema.md)                    | CRM domain model and schema                      | 2026-08-15 |
| [0007](0007-crm-services-and-interface.md)               | CRM services and interface                       | 2026-08-15 |
| [0008](0008-stage-2-security-and-verification.md)        | Stage 2 security and verification                | 2026-08-15 |
| [0009](0009-data-lifecycle-design.md)                    | Designing merge, erasure and ingestion           | 2026-08-15 |
| [0010](0010-lifecycle-implementation.md)                 | Merge, erasure, ingestion and import             | 2026-08-15 |
| [0011](0011-lifecycle-interface-and-reset.md)            | Lifecycle interface, reset, bundle gate          | 2026-08-15 |
| [0012](0012-stage-3-reorder-and-lead-capture-design.md)  | Roadmap reorder and lead capture design          | 2026-08-16 |
| [0013](0013-the-public-path.md)                          | The public path: endpoint, embed, tracker        | 2026-08-16 |
| [0014](0014-the-worker-and-a-hang.md)                    | The worker, and a process that would not exit    | 2026-08-16 |
| [0015](0015-forms-admin-and-the-browser-suite.md)        | Forms administration, and what a browser found   | 2026-08-16 |
| [0016](0016-the-network-boundary-and-the-crawl-model.md) | The network boundary, crawl model and robots.txt | 2026-08-17 |
| [0017](0017-the-permission-boundary-was-a-regex.md)      | The permission boundary was a regex              | 2026-08-17 |
