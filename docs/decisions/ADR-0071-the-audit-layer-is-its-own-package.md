# ADR-0071 — The audit layer is its own package, and it cannot open a socket

**Status:** Accepted
**Date:** 2026-08-24

## Context

Stage 5 interprets the crawler's facts into findings. AGENTS.md §5 draws a hard
line between the two — _"the crawler acquires facts, the audit layer interprets
them into findings"_ — and the question was where the interpreting code lives.

Three options were real: inside `packages/crawler`, a new `packages/audit`, or a
new `packages/seo`.

## Decision — a new package, `@growth-os/seo`, depending on contracts and

database only

`packages/seo` has exactly two internal dependencies, `@growth-os/contracts` and
`@growth-os/database`. It does **not** depend on `@growth-os/net`, and it does
**not** depend on `@growth-os/crawler`.

### Why not inside `packages/crawler`

Because then "the audit layer cannot fetch a page" would be a comment.

The crawler depends on `@growth-os/net` — it must, that is its job. Any module
inside it inherits that dependency, so a rule could call `safeFetch`, or call
`fetchPage` directly, and nothing in the build would object. The stage boundary
would be maintained by reviewers noticing.

As a separate package, the same claim is a **lint failure and a boundary probe**.
`verify-boundaries` now writes `import { safeFetch } from '@growth-os/net'` into
`packages/seo` and asserts ESLint rejects it, alongside the same probe for
`node:http` and for `@growth-os/crawler`. That is the difference between an
invariant and an intention, and it is the whole argument for the extra package.

### Why not `@growth-os/crawler` as a dependency either

This is the less obvious half, and it is deliberate.

The audit reads the crawler's **tables**, not its code. Depending on the package
would reintroduce the network reachability the separation just removed — a rule
could call `fetchPage` transitively — and it would couple the interpretation of
facts to the implementation that gathered them, so that a change to how a page
is fetched could change what an audit concludes about an already-recorded crawl.

The cost is real and accepted: the two packages agree on the meaning of
`crawl_pages.outcome`, `crawl_links.scope` and `normalised_url` through the
schema and `@growth-os/contracts`, not through a shared function. That is the
same trade `@growth-os/net` already makes with `CRAWL_FAILURE_CATEGORIES` —
"kept in agreement by a test rather than by an import".

**It does NOT mean re-deriving anything.** The orphan rule performs no URL
normalisation and no scope classification: it joins on `target_url` and reads
`scope`, both already produced by the single `normaliseUrl` and the single
`classifyScope` (§5, URL identity is singular). Writing a second one here is the
exact mistake dev log 0054 was written about; not depending on the crawler is
not a licence to duplicate it.

### Why `seo` and not `audit`

`audit` is taken, and taken by something a security reviewer must not confuse
this with. `audit.ts`, the `audit_events` table and ADR-0013 are the
**append-only audit trail** — who did what, for compliance. A `packages/audit`
containing SEO findings would collide with that name in every search, import
and conversation about the codebase.

`seo` also matches the vocabulary the product and roadmap already use, and the
table it writes is `seo_findings` (ADR-0070).

## Alternatives considered

**A. `packages/crawler/src/audit/`.** Rejected above: it makes the network
boundary unenforceable for this code, which is the one property most worth
enforcing.

**B. `packages/audit`.** Rejected on the name collision with the compliance
audit trail.

**C. Put the rules in `apps/worker`.** Rejected. A rule is domain logic, and the
worker is a process, not a layer (see the worker boundary block in
`eslint.config.mjs`). It would also make the rules unreachable from anywhere
else that later needs them — Stage 8's SEO Agent among them.

**D. Allow `@growth-os/crawler` as a dependency "just for the types".**
Rejected. The types that matter are in `@growth-os/contracts` already, which is
where a shared vocabulary belongs (ADR-0001). A dependency taken for types is a
dependency, and it carries `safeFetch` with it.

## Consequences

- Three new boundary probes; `verify:boundaries` reports **35** enforced, up
  from 32.
- The ESLint allowance is written as a **negation** —
  `['@growth-os/*', '!@growth-os/contracts', '!@growth-os/database']` — so a
  package added later is denied by default rather than silently permitted until
  someone remembers to extend a forbidden-list. Both halves were probed: the
  denial fails lint and the allowance passes it.
- `packages/seo` cannot be given a job queue, an HTTP client or a crawler
  handle without an ADR superseding this one.
- Stage 8's SEO Agent will call into this package rather than into the crawler.

## What this does NOT decide

How an audit is triggered — no scheduler, no job type, no call site exists yet.
`recordOrphanPages` takes a transaction and a crawl id and nothing calls it in
production. That is deliberate: wiring it into the crawl lifecycle is a separate
decision about when an audit runs, which is not this ADR's to make.
