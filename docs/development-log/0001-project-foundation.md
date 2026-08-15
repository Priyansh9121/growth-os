# 0001 — Project foundation and toolchain

**Date:** 2026-08-15 · **Stage:** 1

## Objective

Establish a monorepo, toolchain and repository safety baseline for a
multi-tenant commercial SaaS product.

## Initial state

Empty directory. No git repository, no files.

## Investigation

Environment probe before assuming anything:

| Finding                                                  | Consequence                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Node 24.15, npm 11.12, git 2.54                          | Modern baseline; no polyfills needed                                                      |
| **No pnpm, no yarn**                                     | Chose npm workspaces ([ADR-0002](../decisions/ADR-0002-monorepo-and-package-strategy.md)) |
| **No Docker**                                            | Provided `docker-compose.yml` for others but could not use it                             |
| PostgreSQL 18.4 running on :5432, **password-protected** | The user's own instance — not touched                                                     |

Needing a real database to verify migrations and RLS rather than assume them, I
stood up an **isolated cluster** in scratch space on port 55432. Homebrew's
`postgresql@17` turned out to be incomplete (missing `postgres.bki`, then a
broken timezone directory); the EDB PostgreSQL 18 installation at
`/Library/PostgreSQL/18` worked. Recorded because "just use the local
PostgreSQL" was not viable and the workaround is not obvious.

Version check before pinning revealed **TypeScript 7.0.2** and **ESLint 10**
are current. Both were rejected in favour of TypeScript 5.9.3 and ESLint 9.39.5:
`eslint-config-next@16` declares `eslint >=9`, and TS 7 is too new for the
surrounding tool ecosystem. Stability over novelty in the foundation.

An initial `npm install` failed on `@types/react-dom@^19.2.5` (does not exist);
several other assumed versions were wrong. All were corrected against the
registry rather than guessed.

## Decisions

1. **npm workspaces**, five workspaces, no build step — packages are consumed
   as TypeScript source ([ADR-0002](../decisions/ADR-0002-monorepo-and-package-strategy.md)).
2. **TypeScript strict plus four extra flags.** `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes` were chosen specifically because tenancy and
   authorization code depends on them: the former makes a missing capability
   entry a compile error rather than a silent allow.
3. **Only packages with a present-day purpose exist.** No empty `packages/events`
   or `packages/observability` to match a diagram.

## Alternatives considered

- **pnpm** — better for monorepos (strict layout prevents phantom
  dependencies), but requires a bootstrap step and was absent. Recorded in
  ADR-0002 as the weakest decision and the most likely reversal.
- **Turborepo** — nothing to cache with no build steps.
- **TypeScript 7** — too new for the tool ecosystem.

## Files created

`package.json` (workspaces, command surface) · `tsconfig.base.json` ·
`.gitignore` · `.env.example` · `.editorconfig` · `.prettierrc.json` ·
`.prettierignore` · `.gitattributes` · `.nvmrc` · five workspace
`package.json` + `tsconfig.json` files.

## Architecture impact

Established the layout that [ADR-0001](../decisions/ADR-0001-architecture-style.md)
depends on: domain logic in framework-free packages, `apps/*` as runtime hosts.
Without this shape, the pre-committed Stage 3 and Stage 13 extractions would be
rewrites.

## Security impact

`.gitignore` was written with **anchored patterns** from the outset, with a
header explaining why. `.env.example` uses placeholders only and documents the
generation command for `SESSION_SECRET`.

The anchoring turned out to be insufficient anyway — see
[0005](0005-verification-and-measurement.md).

## Testing

None yet; toolchain only.

## Result

`npm install` succeeds (538 packages), workspace symlinks resolve, lockfile
committed.

## Remaining work

Test harness, lint configuration and the safety verifiers — all in later
entries.
