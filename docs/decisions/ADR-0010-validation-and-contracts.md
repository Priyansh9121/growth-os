# ADR-0010 — Zod at every trust boundary

**Status:** Accepted
**Date:** 2026-08-15

## Context

TypeScript types vanish at runtime. Every value crossing into the process from
outside — request bodies, query strings, cookies, environment variables,
third-party API responses, webhook payloads, and **AI tool arguments** — is
`unknown` in reality no matter what the type annotation claims.

Growth OS will eventually accept input from LLM-generated tool calls and from
webhooks signed by external systems. Those are the two least trustworthy input
sources in the product, and both must be validated with the same rigour as a
public form post.

## Decision

**Zod v4** is the validation library, and validation is mandatory at every trust
boundary. Schemas live in `@growth-os/contracts` and are the single definition
from which TypeScript types are inferred — never the other way around.

```ts
// Correct: schema first, type derived.
export const loginInputSchema = z.object({ … });
export type LoginInput = z.infer<typeof loginInputSchema>;
```

Boundaries where a schema parse is **required**:

| Boundary                                 | Schema location                          | Enforced today                           |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| HTTP request bodies and query params     | `contracts/src/auth`, `contracts/src/ai` | ✅                                       |
| Environment variables (at process start) | `contracts/src/env.ts`                   | ✅                                       |
| AI tool arguments (model → application)  | `contracts/src/ai/tool.ts`               | ✅ (contract exists; no model connected) |
| AI tool results (application → model)    | same                                     | ✅                                       |
| Webhook payloads                         | Stage 13+                                | ⬜                                       |
| Third-party API responses                | Stage 5+                                 | ⬜                                       |

Failures raise a typed `ValidationError` carrying field-level detail, which the
HTTP layer renders as a stable error envelope. See
[error-handling.md](../engineering/error-handling.md).

### Environment validation is fail-fast

`packages/contracts/src/env.ts` parses `process.env` once at startup and
**throws**, refusing to boot, on a missing or malformed required variable — with
the offending keys named and their values never printed. A typo in
`DATABASE_URL` should be a startup failure with a clear message, not a confusing
error under load an hour later. Production additionally rejects known-unsafe
defaults (for example the placeholder `SESSION_SECRET`).

## Alternatives considered

### A — Zod v4 (chosen)

_Why:_ the de facto standard, excellent inference, composable, good error
shapes, and v4 substantially improved performance and bundle size over v3. Its
JSON Schema output is directly relevant: AI tool definitions must be expressed
as JSON Schema for a model, and being able to derive that from the same Zod
schema that validates the result removes an entire class of drift between "what
the model was told" and "what we accept".

_Cost:_ a runtime dependency in the hot path; schemas add code weight.

### B — Valibot

_Attractive because:_ significantly smaller bundle through modular imports.

**Rejected because:** the bundle advantage matters most on the client, and our
validation is overwhelmingly server-side. Zod's ecosystem — particularly
JSON-Schema interop for AI tools and Drizzle integration — is worth more than
the kilobytes.

### C — TypeBox / ajv (JSON Schema first)

_Attractive because:_ JSON Schema is native, which suits AI tool definitions
perfectly, and ajv is very fast.

**Rejected because:** developer ergonomics are notably worse for everyday
request validation, and TypeScript inference is weaker. We get the JSON Schema
benefit from Zod's converter without paying the ergonomic cost everywhere.

### D — `class-validator` / decorators

**Rejected because:** it requires decorators and `reflect-metadata`, couples
validation to class shapes, and fits poorly with a functional codebase and with
`verbatimModuleSyntax`.

### E — Hand-written type guards

**Rejected because:** they drift from the types they guard, and nobody writes
exhaustive ones under deadline pressure. The failure mode is silent.

## Consequences

### Positive

- One definition per contract: schema and type cannot disagree.
- AI tool arguments are validated with the same machinery as public HTTP input —
  which is exactly the right posture given a model may emit anything.
- Environment misconfiguration fails at boot with an actionable message.
- Field-level errors are available for form UX without a second schema.

### Negative

- Runtime cost on every request. Acceptable; measure before optimising.
- Schema and database column definitions are separate artefacts and can drift.
  Mitigated by deriving schemas from Drizzle table types where practical, and by
  integration tests that exercise both.
- Zod v4 changed some APIs from v3; examples found online may not apply.

## Revisit when

- Bundle size on the client becomes a measured problem → move client-side
  validation to a lighter library while keeping Zod server-side.
- A schema registry is needed for versioned public API contracts (Stage 21).

## Related

- [engineering/error-handling.md](../engineering/error-handling.md)
- [architecture/ai-agent-architecture.md](../architecture/ai-agent-architecture.md)
