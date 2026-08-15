# Event Architecture

**Status:** ⬜ **NOT BUILT.** Design recorded so the foundation does not preclude it.
**Target:** Stage 12 (automation), needed in part from Stage 3.

## Why it will be needed

Attribution (Stage 15) must observe everything that happens across every
domain. If each module calls each other module directly, the attribution
module becomes a dependency of the entire system and every new feature has to
remember to tell it.

An event backbone inverts that: modules announce what happened; consumers
subscribe. Attribution, automation and reporting all become consumers rather
than coupling points.

## Planned design

**Transactional outbox**, deliberately not a message broker first.

```
Application service
      │  (one transaction)
      ├──▶ domain tables
      └──▶ outbox_events
                │
                ▼  relay polls
          in-process bus  ──▶  handlers
                │
                ▼  (later, when volume needs it)
            Redis / queue
```

### Why an outbox rather than publishing directly

Publishing to a broker inside a transaction gives you the dual-write problem:
the transaction commits and the publish fails (an event is lost), or the
publish succeeds and the transaction rolls back (an event describes something
that never happened). Writing the event to a table **in the same transaction**
makes atomicity free, and a relay delivers it afterwards.

### Why in-process first

At one instance there is nothing to distribute. The outbox is the part that is
expensive to retrofit; the transport is a swap.

## Event shape

```ts
interface DomainEvent<T> {
  id: string;
  workspaceId: string; // tenancy travels with the event
  name: string; // 'crm.lead.qualified' — domain.entity.past_tense
  version: number; // schema version, for evolution
  occurredAt: string;
  actor: { type: 'user' | 'agent' | 'system'; id: string | null };
  correlationId: string; // ties back to the request and the audit trail
  payload: T; // Zod-validated
}
```

Past tense, always: an event records something that **already happened**. A
present-tense name is a command in disguise, and commands do not belong on an
event bus.

## Delivery semantics

**At-least-once**, so every handler must be **idempotent** — keyed on
`event.id`. Exactly-once delivery is not achievable; idempotent handlers make
it unnecessary.

Ordering is guaranteed **per workspace**, not globally. Global ordering would
serialise all tenants behind each other.

## What already exists

`audit_events` is the read-only half of this pattern: append-only, tenant
scoped, correlation-ID carrying. It is not a bus — nothing consumes it — but
the shape is deliberately compatible, so the outbox can adopt the same
conventions rather than inventing new ones.

## Known gap

Audit writes are currently **best-effort** — a failure is logged and swallowed,
because an audit failure must not fail the operation it describes. When
regulatory-grade guarantees are needed (Stage 18), audit writes move into the
outbox and inherit its transactional atomicity.
