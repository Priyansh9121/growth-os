# Dependency Policy

**Status:** Active

Every dependency is a permanent liability: an upgrade treadmill, a supply-chain
attack surface, bundle weight, and a thing the next engineer must learn.

## Questions before `npm install`

1. **What problem does it solve?** Name it in one sentence.
2. **Can platform code solve it easily?** Node and modern browsers do far more
   than they did. `crypto.randomUUID`, `structuredClone`, `Intl`, `fetch`,
   `AbortController` all replace packages people still install.
3. **Is it maintained?** Recent releases, responsive issues, more than one
   maintainer. **A deprecated library is disqualifying** — this is why Lucia was
   rejected for authentication despite fitting the design perfectly.
4. **Bundle cost?** Client-side dependencies are weighed against the
   [performance budget](../design/performance-budget.md).
5. **Security surface?** Transitive count, install scripts, whether it handles
   untrusted input.
6. **Does it overlap something we have?** Two date libraries is how a codebase
   ends up with two date libraries.

## Decisions we made by asking these

| Wanted                          | Chose                                                           | Because                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 3D helpers                      | **Wrote ~200 lines** instead of `@react-three/drei`             | We needed 4 helpers from a large grab-bag; the bundle is the main risk of that feature                                            |
| Colour maths for contrast tests | **Wrote ~40 lines** of OKLCH→sRGB                               | A colour library in the dependency graph for a test would fail our own policy                                                     |
| Component library               | **First-party primitives**                                      | Adopting shadcn/ui means shipping a recognisable look we were told not to ship                                                    |
| Icons                           | **First-party SVG**                                             | An icon package for ~8 icons is pure weight                                                                                       |
| Boundary linting                | **`no-restricted-imports`**, removed `eslint-plugin-boundaries` | The plugin could not resolve workspace packages and enforced nothing. We deleted the dependency rather than keep a decorative one |
| Authentication                  | **First-party**                                                 | Tenancy mismatch and per-MAU pricing ([ADR-0004](../decisions/ADR-0004-authentication.md))                                        |

## Current dependencies

**Runtime:** `next`, `react`, `react-dom`, `zod`, `drizzle-orm`, `postgres`,
`@node-rs/argon2`, `libphonenumber-js`, `three`, `@react-three/fiber`,
`motion`, `geist`, `clsx`, `tailwind-merge`.

Stage 2 added exactly one runtime dependency and removed none.

Each is justified in an ADR or above. The riskiest is `drizzle-orm` — pre-1.0,
so minor releases may break. Mitigated by pinning and by all usage being
confined to one package.

## Rules

- **Pin with `^`** and commit the lockfile. Never edit a lockfile by hand.
- **Exact-pin anything security-critical** when a patch release has burned us.
- Prefer zero-dependency packages.
- Prefer `devDependencies` — build tooling never ships.
- Audit before adding: `npm view <pkg>` for maintenance, `npm ls <pkg>` for
  duplicates.
- **Removing a dependency needs no justification.** Removals are always welcome.

## Upgrades

Patch and minor: routinely, with the full suite. Major: deliberately, one at a
time, reading the changelog. Security advisories: immediately.

Never upgrade a major version to fix an unrelated bug — that is two changes
wearing one commit message.
