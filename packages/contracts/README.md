# @growth-os/contracts

The vocabulary every other package speaks: shared types, Zod schemas, the typed
error taxonomy, tenancy roles and capabilities, and the AI tool contract.

## Why it exists

One definition of every cross-boundary shape. Schemas come first and types are
**inferred from them**, never the reverse — so validation and types cannot
drift.

## Responsibilities

- The `AppError` hierarchy and the `message` / `publicMessage` split
- Roles, capabilities and the `Actor` / `TenantActor` types
- Validation schemas for every trust boundary
- Growth metric types, which encode provenance so a fixture cannot render as a
  measurement
- The `AgentTool` contract and the `invokeTool` guard chain
- Environment validation (separate entry point — see below)

## NOT its responsibilities

Any I/O. No database, no HTTP, no filesystem.

## Dependencies

`zod`, and **nothing internal**. It sits at the bottom of the graph; a
dependency here would make it un-importable from somewhere.

## Entry points

| Import                     | Contents                                                 |
| -------------------------- | -------------------------------------------------------- |
| `@growth-os/contracts`     | Errors, tenancy, auth schemas, growth types, AI contract |
| `@growth-os/contracts/env` | **Server-only** environment validation                   |

`env.ts` is deliberately **not** re-exported from the index: it reads
`process.env`, and a separate entry point is what prevents a client component
from pulling secrets into a browser bundle.

## Two invariants worth knowing

- **`publicMessage` is the only error field that may reach a client.** Everything
  else is for logs. This split exists because rendering an exception verbatim is
  the most common way products leak internals.
- **A `MetricValue` cannot exist without declaring its provenance.** There is no
  way to render a number in this product without stating whether it is live, an
  estimate, unavailable or a fixture — the type system will not allow it.

## Testing

Pure unit tests. No fixtures, no mocks, no database.
