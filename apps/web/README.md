# apps/web

The Growth OS web application: the authentication surface, the operator
dashboard, and the HTTP API the browser uses.

## Why this exists as an app rather than a package

It owns **transport and rendering**, not business rules. Domain logic lives in
`packages/*` so that `apps/api` (Stage 21) and `apps/worker` (Stage 3) can be
added by importing the same code rather than rewriting it.

## Responsibilities

- Render authenticated and unauthenticated surfaces
- Validate and authorize inbound HTTP requests
- Compose domain services (`src/server/dependencies.ts` is the composition root)
- Own the login → dashboard transition

## Explicitly NOT its responsibilities

- Business rules, authorization logic, session mechanics → `@growth-os/auth`
- Schema and queries → `@growth-os/database`
- Visual language → `@growth-os/ui`
- Shared types and validation → `@growth-os/contracts`

## Dependencies

May import any `@growth-os/*` package, plus Next.js and React.
**Must never** be imported by a package, or import another app.

## Entry points

| Path                            | Role                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app/layout.tsx`            | Root layout. Hosts the transition machine and the scene — **both must stay here**, because route-group layouts unmount on navigation |
| `src/app/(auth)/login/page.tsx` | The flagship threshold surface                                                                                                       |
| `src/app/(app)/layout.tsx`      | **The authorization gate** for every app route                                                                                       |
| `src/app/api/**`                | Route handlers — thin adapters over domain services                                                                                  |
| `src/proxy.ts`                  | Edge routing. **Not a security boundary**                                                                                            |
| `src/server/**`                 | Server-only. Marked `import 'server-only'` so a client import is a build error                                                       |

## Structure

`app/` routes · `server/` server-only composition · `features/` vertical slices
that own state · `components/` shell and dashboard composition · `lib/`
navigation manifest and fixtures.

Features do not import each other.

## The two things most likely to be broken by accident

1. **Moving `AuthTransitionProvider` or `GrowthFieldHost` out of the root
   layout.** Both depend on surviving the `/login → /dashboard` navigation.
   Moving them into a route group silently breaks the continuous transition and
   makes the entrance replay on every refresh.
2. **Treating `src/proxy.ts` as an authorization boundary.** It performs a
   cookie-_presence_ check only, has no database access, and can be bypassed in
   some deployment topologies. Every real decision happens in
   `src/server/auth-context.ts`.

## Testing

Component and accessibility tests in jsdom (`*.test.tsx`); the transition
machine has pure unit tests (`*.test.ts`). Run with `npm run test:web` and
`npm run test:unit`.
