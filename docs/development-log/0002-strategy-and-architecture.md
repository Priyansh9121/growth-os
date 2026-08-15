# 0002 — Product strategy, architecture and ADRs

**Date:** 2026-08-15 · **Stage:** 0 → 1

## Objective

Decide what Growth OS is, who it is for, and under what architectural
constraints — before writing product code.

## Initial state

Toolchain in place ([0001](0001-project-foundation.md)). No product definition.

## Investigation

The brief spans SEO, CRM, voice, automation and attribution — domains normally
sold as separate products. The central question was whether that breadth is a
bundle or a single thing.

It is a single thing. Every one of those domains is a **segment of one causal
chain**, and no mainstream product owns the whole chain. That observation
determined nearly everything downstream:

- **Strategy:** the differentiator is _the join_, not any individual module.
- **Architecture:** the core query is a multi-way join with strict consistency
  requirements — the canonical argument _against_ premature service
  decomposition.
- **Roadmap:** stages are ordered by what the join needs, not by what is
  easiest to demo. Attribution is Stage 15 because it depends on twelve
  earlier stages, not because it is hard.

## Decisions

Ten ADRs, each recording rejected alternatives and costs.

| ADR  | Decision                                     | The deciding factor                                                                                                                             |
| ---- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | Modular monolith                             | The attribution join is relational and transactional                                                                                            |
| 0002 | npm workspaces, TS-source packages           | No bootstrap step; no build step to cache                                                                                                       |
| 0003 | PostgreSQL + Drizzle                         | **Row-level security.** Prisma's `SET LOCAL` handling is more fragile, and fragility in the tenancy mechanism is disqualifying                  |
| 0004 | First-party session auth                     | Hosted providers' tenancy models cannot express user→membership→workspace with a second agency path; per-MAU pricing opposes the agency channel |
| 0005 | Workspace tenancy via memberships + RLS      | `users.workspace_id` would make the agency channel unbuildable                                                                                  |
| 0006 | Next.js, Tailwind v4, first-party primitives | The brief rules out looking like a template; shadcn's identity is now recognisable                                                              |
| 0007 | three.js + R3F, **no drei**                  | Bundle size is the main risk of the 3D feature; we needed 4 helpers from a large grab-bag                                                       |
| 0008 | Persistent scene host + state machine        | A canvas in a route group unmounts on navigation, making continuity impossible                                                                  |
| 0009 | In-process rate limiting                     | Correct at one instance; the interface makes Redis a driver swap                                                                                |
| 0010 | Zod at every boundary                        | AI tool arguments need the same rigour as public HTTP input                                                                                     |

Two rejections worth noting because they were close calls:

- **Prisma** would be defensible for a product without the RLS requirement. Ours
  has it, and the `SET LOCAL`-on-a-pooled-connection pattern is more fragile
  there. When the mechanism protecting tenant data is fragile, that decides it.
- **Lucia** matched the intended auth design almost exactly — and is
  deprecated. Adopting a deprecated dependency for the authentication core is
  not defensible.

## Files created

`docs/product/` (vision, principles, roadmap, personas, journeys, feature map,
terminology) · `docs/architecture/` (10 documents) ·
`docs/decisions/` (README + 10 ADRs) · `docs/design/` (brand, design system,
motion, 3D, login specification).

`docs/design/login-experience.md` was written **before any login code**, as the
build order requires.

## Architecture impact

Everything downstream. The terminology document in particular is load-bearing:
it caught the `Opportunity` collision (growth-loop vs CRM) before either
existed, which would otherwise have become an ambiguous type name in two
domains.

## Security impact

The threat model was written to include **unbuilt** features — crawler SSRF
(Stage 3) and prompt injection (Stage 7) — because both are far cheaper to
design against now than to retrofit. The SSRF analysis is the direct reason
`apps/worker` is pre-committed as a separately network-restricted runtime
rather than left as an optimisation.

## Testing

None — documentation only.

## Result

Every foundational choice has a recorded rationale, a rejected alternative and
a stated cost.

## Remaining work

Implementation. Documents were revised afterwards where implementation proved
them wrong — notably the boundary-enforcement mechanism in
[0005](0005-verification-and-measurement.md).
