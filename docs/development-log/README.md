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

| #                                                        | Title                                                       | Date       |
| -------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| [0001](0001-project-foundation.md)                       | Project foundation and toolchain                            | 2026-08-15 |
| [0002](0002-strategy-and-architecture.md)                | Product strategy, architecture and ADRs                     | 2026-08-15 |
| [0003](0003-authentication-and-tenancy.md)               | Database, authentication and multi-tenancy                  | 2026-08-15 |
| [0004](0004-design-system-and-login.md)                  | Design system, 3D login and the transition                  | 2026-08-15 |
| [0005](0005-verification-and-measurement.md)             | Verification, measurement and hardening                     | 2026-08-15 |
| [0006](0006-crm-domain-and-schema.md)                    | CRM domain model and schema                                 | 2026-08-15 |
| [0007](0007-crm-services-and-interface.md)               | CRM services and interface                                  | 2026-08-15 |
| [0008](0008-stage-2-security-and-verification.md)        | Stage 2 security and verification                           | 2026-08-15 |
| [0009](0009-data-lifecycle-design.md)                    | Designing merge, erasure and ingestion                      | 2026-08-15 |
| [0010](0010-lifecycle-implementation.md)                 | Merge, erasure, ingestion and import                        | 2026-08-15 |
| [0011](0011-lifecycle-interface-and-reset.md)            | Lifecycle interface, reset, bundle gate                     | 2026-08-15 |
| [0012](0012-stage-3-reorder-and-lead-capture-design.md)  | Roadmap reorder and lead capture design                     | 2026-08-16 |
| [0013](0013-the-public-path.md)                          | The public path: endpoint, embed, tracker                   | 2026-08-16 |
| [0014](0014-the-worker-and-a-hang.md)                    | The worker, and a process that would not exit               | 2026-08-16 |
| [0015](0015-forms-admin-and-the-browser-suite.md)        | Forms administration, and what a browser found              | 2026-08-16 |
| [0016](0016-the-network-boundary-and-the-crawl-model.md) | The network boundary, crawl model and robots.txt            | 2026-08-17 |
| [0017](0017-the-permission-boundary-was-a-regex.md)      | The permission boundary was a regex                         | 2026-08-17 |
| [0018](0018-the-regex-sweep.md)                          | The regex sweep, and what it actually found                 | 2026-08-17 |
| [0019](0019-the-url-length-ceiling.md)                   | The URL length ceiling, and two caps                        | 2026-08-18 |
| [0020](0020-the-step-budget.md)                          | The step budget, and three numbers the brief had wrong      | 2026-08-18 |
| [0021](0021-the-fail-open-defects.md)                    | The fail-open defects, and a third found while measuring    | 2026-08-18 |
| [0022](0022-the-query-identity-collision.md)             | The query identity collision, and the last §5 violation     | 2026-08-18 |
| [0023](0023-one-migration-three-findings.md)             | One migration, three findings, and the first live §7.2      | 2026-08-18 |
| [0024](0024-three-claims-the-code-does-not-keep.md)      | Three claims the code does not keep, and a fourth found     | 2026-08-19 |
| [0025](0025-one-landing-path-normaliser.md)              | One landing-path normaliser, and a table seven short        | 2026-08-19 |
| [0026](0026-one-absolute-url-test.md)                    | One absolute-URL test, and a fifth copy nobody counted      | 2026-08-19 |
| [0027](0027-the-field-target-cap.md)                     | The field target cap, and a length check that gates nothing | 2026-08-19 |
| [0028](0028-one-like-escaper.md)                         | One LIKE escaper, and a near-miss correcting 0018           | 2026-08-19 |
| [0029](0029-the-body-ceiling-and-a-backlog-pass.md)      | The body ceiling, and 0018's backlog closed out             | 2026-08-19 |
| [0030](0030-the-limits-merge-and-two-closed-items.md)    | The limits merge, and two items closed not carried          | 2026-08-19 |
| [0031](0031-the-last-three-and-the-backlog-is-empty.md)  | The last three, and the cleanup backlog is empty            | 2026-08-19 |
| [0032](0032-the-sitemap-parser.md)                       | The sitemap parser, and a comment that shipped too early    | 2026-08-19 |
| [0033](0033-sitemap-discovery-reaches-the-frontier.md)   | Sitemap discovery reaches the frontier                      | 2026-08-19 |
| [0034](0034-the-crawl-run.md)                            | The crawl run, and a termination check that stops early     | 2026-08-19 |
| [0035](0035-the-status-document.md)                      | The status document, and where the house style stops        | 2026-08-19 |
| [0036](0036-the-crawler-gets-a-caller.md)                | The crawler gets a caller, and a CHECK corrected the design | 2026-08-19 |
