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

| #                                            | Title                                      | Date       |
| -------------------------------------------- | ------------------------------------------ | ---------- |
| [0001](0001-project-foundation.md)           | Project foundation and toolchain           | 2026-08-15 |
| [0002](0002-strategy-and-architecture.md)    | Product strategy, architecture and ADRs    | 2026-08-15 |
| [0003](0003-authentication-and-tenancy.md)   | Database, authentication and multi-tenancy | 2026-08-15 |
| [0004](0004-design-system-and-login.md)      | Design system, 3D login and the transition | 2026-08-15 |
| [0005](0005-verification-and-measurement.md) | Verification, measurement and hardening    | 2026-08-15 |
