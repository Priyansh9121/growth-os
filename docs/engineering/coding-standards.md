# Coding Standards

**Status:** Enforced by TypeScript, ESLint and Prettier where possible.

## TypeScript

`strict` plus four flags that close bug classes we cannot afford in tenancy or
authorization code — see [`tsconfig.base.json`](../../tsconfig.base.json):

| Flag                         | What it prevents                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `noUncheckedIndexedAccess`   | `capabilities[role]` is `Set \| undefined`, so a missing capability entry cannot silently read as "allowed"                           |
| `exactOptionalPropertyTypes` | An explicit `undefined` cannot satisfy `workspaceId?: string`, preserving the difference between "not scoped" and "scoped to nothing" |
| `noImplicitOverride`         | Accidental behaviour changes in the error hierarchy                                                                                   |
| `noFallthroughCasesInSwitch` | Silent bugs in state machines                                                                                                         |

**`any` is a warning, not an error** — third-party interop occasionally needs
it — but it must never appear in an authorization or tenancy path. Prefer
`unknown` plus a schema parse.

## Structure

- **Small, cohesive modules.** Split by responsibility, not by line count.
  There is no hard limit; the test is whether the file is still easy to reason
  about.
- **No `utils.ts`, `helpers.ts` or `manager.ts`.** These names attract
  unrelated code. Name the responsibility.
- **No god services, no circular dependencies, no hidden global state.** The
  two module-level singletons that exist (`getDatabase`, `getDependencies`) are
  singletons for correctness — the rate limiter's counters live in its
  instance — and are documented as such.
- **Dependencies point downward**, enforced by lint and verified by
  `scripts/verify-boundaries.mjs`.

## Comments

> **Explain WHY. The code already says WHAT.**

```ts
// Bad
// Increment the counter
counter += 1;

// Good
// NOT recorded when already limited: recording would let a third party extend
// a victim's lockout indefinitely by hammering their identifier.
```

Every non-obvious security decision carries a comment explaining the attack it
prevents. Important files open with a header stating architectural
responsibility and major assumptions. Generated files are never annotated.

## Functions

- `require*` throws; `can*` returns a boolean. A `can*` check controls what is
  _rendered_; only `require*` guards data. A hidden button is not a control.
- Authorization helpers are **total** — an unknown role returns `false` rather
  than throwing, because a throw in an error path can be handled into an allow.
- Prefer returning a discriminated result over throwing for _expected_ outcomes
  (tool failures, rate limits). Throw for exceptional ones.

## Async

- Never `await` inside a loop when the work is independent — use
  `Promise.all`.
- Always handle rejection at a boundary.
- Deliberate fire-and-forget is commented with why (there are exactly two:
  post-login rehash and the audit writer).

## React

- Server Components by default; `'use client'` only where interactivity or
  browser APIs are needed.
- Never put secrets in a client component or in a prop that crosses the
  boundary. `toSessionUserView` exists specifically to drop `sessionId` before
  serialisation.
- Effects subscribe and clean up. `useReducedMotion` subscribes to media-query
  _changes_ rather than reading once, because reading once is wrong the moment
  a user toggles the setting.
- No arbitrary design values in components — use a token, or add one.

## Formatting

Prettier decides. It is not a matter of opinion and not worth a review comment.
