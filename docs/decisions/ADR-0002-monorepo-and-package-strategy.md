# ADR-0002 — Monorepo with npm workspaces, TypeScript-source packages

**Status:** Accepted
**Date:** 2026-08-15
**Context as of this date:** Team of one. One runtime host today; three more
pre-committed to later stages. No package will ever be published publicly.

## Context

[ADR-0001](ADR-0001-architecture-style.md) commits us to domain logic living in
packages independent of any runtime host. That requires deciding three things:
repository layout, the workspace tool, and whether packages emit JavaScript.

## Decision

1. **A single repository** containing `apps/*` (runtime hosts) and
   `packages/*` (domain and platform libraries).
2. **npm workspaces** as the workspace manager.
3. **Packages are consumed as TypeScript source.** No package has a build step;
   `exports` points at `src/index.ts` and the consuming application's bundler
   compiles it (`transpilePackages` in Next.js).
4. **Only packages with a present-day purpose exist.** Future packages are
   documented in [architecture/overview.md](../architecture/overview.md), not
   created empty.

Today that is exactly five workspaces: `apps/web`, `packages/contracts`,
`packages/database`, `packages/auth`, `packages/ui`.

## Alternatives considered

### Workspace manager

#### A — npm workspaces (chosen)

_Why:_ ships with Node, so there is no bootstrap step and no version drift
between contributors or CI; sufficient for five workspaces; one lockfile.

_Cost:_ hoisting means a package can import a dependency it does not declare
("phantom dependencies") without failing locally. Mitigated by the boundaries
lint rule and by CI running `npm ci` from a clean tree.

#### B — pnpm

_Attractive because:_ strict `node_modules` layout makes phantom dependencies
impossible — which is genuinely valuable for enforcing boundaries — plus faster
installs and better disk usage.

**Rejected because:** it requires every contributor and CI runner to install and
pin a package manager before the repository works, and it is not present in the
current environment. The specific benefit (phantom dependency prevention) is
partially recovered by the lint rules. **This is the weakest decision in this
ADR and the most likely to be reversed** — the migration is cheap (a lockfile
regeneration) and the trigger is named below.

#### C — Turborepo / Nx

**Rejected because:** their value is build orchestration and caching across many
packages with build steps. We have five workspaces and _no_ build steps
(decision 3), so the cache would have nothing to cache. Adding a build
orchestrator before there are builds to orchestrate is the definition of
premature.

### Packages emitting JavaScript

#### D — TypeScript source, no build (chosen)

_Why:_ no build step in the development loop; go-to-definition lands on real
source rather than a `.d.ts`; no stale-artefact class of bug; no ordering
constraints between packages.

_Cost:_ consumers must transpile our packages (one `transpilePackages` line in
Next.js) and non-bundled consumers need `tsx` or Node type stripping. Both are
already true here. Packages could not be published to npm as-is — irrelevant, as
none are public.

#### E — Each package compiles to `dist/`

**Rejected because:** it introduces build ordering, watch-mode complexity and
stale-artefact bugs, in exchange for a portability benefit we do not need.

### Repository layout

#### F — Multi-repo

**Rejected because:** a cross-cutting change (add a field to the schema, expose
it through auth, render it in the UI) would span three repositories, three pull
requests and a version-bump dance — the exact cost [ADR-0001](ADR-0001-architecture-style.md)
exists to avoid.

## Consequences

### Positive

- Atomic cross-cutting changes; one commit, one review, one CI run.
- One lockfile and one dependency graph, so version skew is impossible.
- Zero bootstrap: `git clone && npm install`.
- Boundaries are enforced by lint, so the layout means something.

### Negative

- **Phantom dependencies are possible** under npm hoisting. A package can import
  something it does not declare and still work locally.
- All CI runs on every change until a task runner is introduced. Acceptable at
  this size; revisit when the suite becomes slow enough to notice.
- Consumers must be configured to transpile internal packages.

### Risks and mitigations

| Risk                                         | Mitigation                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Phantom dependency breaks a later extraction | `eslint-plugin-boundaries` restricts _internal_ edges; before extracting a host, run a clean install and typecheck that package in isolation |
| A package accidentally imports React or Next | Lint rule + code review; domain packages declare no React dependency at all                                                                  |

## Revisit when

- Workspace count exceeds ~10, **or** a phantom-dependency bug reaches CI →
  migrate to pnpm.
- CI wall-clock exceeds ~5 minutes → add Turborepo for task caching.
- A package genuinely needs publishing → give that package (only) a build step.

## Related

- [engineering/repository-map.md](../engineering/repository-map.md)
- [architecture/module-boundaries.md](../architecture/module-boundaries.md)
