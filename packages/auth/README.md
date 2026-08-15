# @growth-os/auth

Password hashing, session lifecycle, tenancy authorization and the login use
case.

## Why it exists

This is the highest-consequence code in the product. It is isolated so it can
be reviewed on its own, and kept framework-free so the same code serves Next.js
today and Fastify later.

## Responsibilities

- Argon2id hashing, and the dummy-verify account-enumeration defence
- Opaque session tokens, hashing at rest, sliding and absolute expiry
- `resolveActor` — the full membership graph, resolved once per request
- `requireWorkspaceAccess` — **the application layer of tenant isolation**
- Rate limiting behind a driver interface
- CSRF origin validation, open-redirect defence, cookie descriptors
- The `login` use case, composing all of the above in a deliberate order

## NOT its responsibilities

HTTP framework types (its `http/` helpers take primitives), rendering, or
business rules outside identity and access.

## Dependencies

`@growth-os/contracts`, `@growth-os/database`, `@node-rs/argon2`, `zod`.
**Never** React, Next.js or `@growth-os/ui` — enforced by lint.

## Read this before changing `login.ts`

**The order of operations is the security design.** Several steps are only
correct in their current position:

1. **Rate limit before any hash.** Argon2 is deliberately expensive; limiting
   afterwards lets the endpoint be used to exhaust our own CPU.
2. **Run a dummy verify when no user exists.** Otherwise the "unknown email"
   path returns tens of milliseconds faster and the endpoint becomes an
   account-enumeration oracle.
3. **Check `disabled_at` after hashing**, so its timing matches too.
4. **Reset only the identifier limit on success.** Resetting the IP limit would
   let an attacker on a shared network clear it at will with their own valid
   credentials.
5. **Always create a new session.** Session fixation defence.

Each is commented in place with the attack it prevents.

## The convention

`can*` returns a boolean and controls what is **rendered**. `require*` throws
and guards **data**. A hidden button is not a security control.

`requireWorkspaceAccess` returns a `TenantActor` rather than a boolean, and
services accept a `TenantActor` — so "forgot to authorize" is a compile error.

## Testing

Exhaustive unit tests over the pure guards, mostly **negative** cases, plus
integration tests for the full login path. A passing happy path proves nothing
about isolation.
