# Module Boundaries

**Status:** Enforced and verified
**Governing ADR:** [ADR-0001](../decisions/ADR-0001-architecture-style.md)

## The rules

```
apps/*      →  any package.  NEVER another app.
packages/*  →  only the edges below.  NEVER apps/*.

   ui         →  (nothing internal)
   contracts  →  (nothing internal)
   database   →  contracts
   auth       →  contracts, database
```

Plus: no domain package (`contracts`, `database`, `auth`) may import React or
Next.js. That constraint is what keeps them hostable by Fastify (Stage 21) and
by the worker (Stage 3) without modification.

## Why each edge is absent

| Missing edge           | Why it must stay missing                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ui → anything`        | A design system that knows about the database is not a design system. It must be reusable by any future surface |
| `contracts → anything` | It is the vocabulary every other package speaks. A dependency here would make it un-importable from somewhere   |
| `database → auth`      | Would invert the graph. The database **enforces** isolation; it does not **decide** access                      |
| `auth → ui`            | Authorization logic is presentation-agnostic                                                                    |
| `packages → apps`      | Would make extracting a runtime host impossible — the whole point of the layout                                 |

## Enforcement — and how we know it works

Enforced by `no-restricted-imports` in
[`eslint.config.mjs`](../../eslint.config.mjs), per package.

### Why not a boundaries plugin

`eslint-plugin-boundaries` was the obvious choice and was tried first. It could
not resolve workspace packages here: `@growth-os/*` specifiers resolve through
npm's `node_modules` symlinks to `exports` entries pointing at TypeScript
source, which its resolver treats as external.

The result was a rule that reported **nothing**. Verified by committing
deliberately illegal imports and watching lint pass.

> **A boundary rule that cannot fail is worse than no rule**, because it
> manufactures confidence. The dependency was removed rather than kept as
> decoration.

`no-restricted-imports` operates on the import **specifier string**, so it
needs no module resolution and is deterministic. Every cross-package import
here uses a `@growth-os/*` specifier, and `../../*` patterns close the
relative-path escape hatch.

### The meta-test

[`scripts/verify-boundaries.mjs`](../../scripts/verify-boundaries.mjs) writes
eight deliberately illegal imports, asserts lint **fails** on each, and cleans
up. Run by `npm run verify:all` and in CI.

```
✓ rejected: ui → database
✓ rejected: ui → contracts
✓ rejected: contracts → database
✓ rejected: contracts → next
✓ rejected: database → auth
✓ rejected: auth → ui
✓ rejected: auth → next
✓ rejected: package escaping its directory with a relative path
```

## Adding an edge

Requires an ADR. Before writing one, check whether the dependency points the
wrong way — usually the shared thing belongs in `contracts`, or the caller
belongs on the other side of the boundary.

## Inside a package

Boundaries between packages are mechanical. Inside one they are conventional:

- `apps/web/src/features/*` are vertical slices that own their state. A feature
  may use `components/` and `lib/`; features do not import each other.
- `apps/web/src/server/*` is server-only, marked with `import 'server-only'` so
  a client import is a **build error** rather than a runtime secret leak.
- `packages/auth/src/authorization/*` is pure — no I/O — which is what makes it
  exhaustively unit-testable.
