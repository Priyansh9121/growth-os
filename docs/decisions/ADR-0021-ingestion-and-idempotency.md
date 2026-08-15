# ADR-0021 — One ingestion boundary, with idempotency receipts

**Status:** Accepted
**Date:** 2026-08-15

## Context

Stage 3 opens automated lead capture. After it come voice, ads integrations,
webhooks and the public API. Each will need to: normalise identity, look for a
duplicate, create-or-match a contact, record an acquisition, maybe open an
opportunity, write a timeline entry and emit an event.

If every channel implements that itself, they will differ — in dedup behaviour,
in what provenance confidence they claim, in whether they are safe to retry.
Attribution would then depend on which integration happened to write the row.

Separately: **every one of those callers retries.** Webhook providers retry on
timeout. Browsers retry on flaky connections. Import runs get re-run. Without
an idempotency model, a retried submission creates a second acquisition and
inflates the exact metric the product is sold on.

## Decision

### 1. One canonical service: `ingestAcquisition`

Every automated path calls it. It is channel-neutral — it knows nothing about
forms, calls or webhooks — and takes:

```ts
{ identity:   { firstName, lastName?, email?, phone? },
  provenance: Provenance,                    // required confidence (ADR-0012)
  idempotency:{ sourceSystem, externalKey }, // optional but strongly encouraged
  opportunity?: { title, estimatedValueMinor?, pipelineId? },
  trust?:     { origin?, submittedAt?, assessment? } }
```

`trust` is the seam for Stage 3's abuse controls. Spam scoring, bot detection
and origin verification happen in the **adapter** and arrive here as a decision;
they never enter CRM domain logic. That keeps anti-abuse replaceable without
touching the CRM.

### 2. Matching policy is explicit, never implicit

`match_then_create` (default) attaches the acquisition to an existing contact
found by exact normalised email or phone; `always_create` never matches.

This is **not** the same as merging. Matching an _incoming_ acquisition to a
known person is safe and reversible — the acquisition can be re-pointed.
Merging two existing contacts is destructive, requires a human, and is governed
by [ADR-0019](ADR-0019-contact-merge.md).

### 3. Idempotency: receipts scoped per workspace and source

```
ingestion_receipts (workspace_id, source_system, external_key)  UNIQUE
                   request_digest, contact_id, acquisition_id, opportunity_id, status
```

The key is scoped to `(workspace, source_system)` because **third-party ids are
not globally unique**. Two form providers can both emit `submission_1`; a
Facebook lead id and a Google lead id can collide. Anything else invites
cross-source collisions that would silently drop a real lead.

Behaviour:

| Situation                         | Result                                                 |
| --------------------------------- | ------------------------------------------------------ |
| New key                           | Ingest, write receipt, return `created`                |
| Same key, **same** request digest | Return the original ids, `duplicate` — **no new rows** |
| Same key, **different** digest    | `ConflictError`. Never silently overwrite              |
| No key supplied                   | Ingest, no receipt. Caller accepts retry risk          |

The digest is a SHA-256 over the normalised identity and provenance —
deliberately **not** over the raw payload, so a provider adding a field or
reordering JSON does not turn a retry into a conflict.

### 4. Receipts store digests, never payloads

The receipt keeps the digest and the resulting ids. It does **not** store the
raw request, which would be a second copy of customer PII in a table nobody
thinks of as customer data — outside erasure's reach and invisible to retention
policy.

### 5. The whole thing is one transaction

Contact, acquisition, opportunity, activity and receipt commit together. A
receipt written for an ingestion that rolled back would cause the retry to be
reported as a duplicate and the lead lost permanently — the worst possible
failure for this subsystem.

### 6. Events carry identifiers only

`crm.acquisition.ingested` → workspace, contact id, acquisition id, optional
opportunity id, source type, whether the contact was matched or created,
timestamp. No name, no email, no phone, no full UTM payload. Events fan out to
subscribers, queues and logs; PII in one is PII everywhere.

## Alternatives considered

**Let each channel call the existing `createContact` / `recordAcquisition`** —
what Stage 2 leaves possible, and the reason for this ADR. Divergent dedup and
provenance behaviour per channel is exactly how attribution becomes untrustworthy.

**Global idempotency keys** — third-party ids collide. Scoping to
`(workspace, source_system)` costs one column and removes the whole class.

**Idempotency by full-payload hash, no key** — a provider adding a tracking
field changes the hash and the retry becomes a duplicate lead.

**Store raw payloads for debugging** — attractive until it is a shadow PII
store outside erasure. Digest only.

**Return the existing result on a conflicting same-key request** — silently
hides a real integration bug and can attach one person's data to another's
acquisition. Conflict is the honest answer.

## Consequences

### Positive

- One code path for every channel; one place to fix a dedup bug.
- Retries are safe, which is a precondition for public endpoints.
- Anti-abuse plugs in at the adapter without touching the CRM.
- No PII in receipts or events.

### Negative

- Callers must supply a stable external key to get idempotency; without one,
  retries duplicate. Documented in the Stage 3 contract.
- Receipts grow unboundedly. Retention is a named follow-up — they hold no PII,
  so the pressure is storage rather than privacy.

## Revisit when

- Stage 3 ships the first adapter — confirm `trust` is the right seam.
- Receipt volume needs pruning.
- A channel legitimately needs a matching policy neither option expresses.

## Related

- [ADR-0012](ADR-0012-provenance-model.md) · [ADR-0019](ADR-0019-contact-merge.md)
- [architecture/ingestion-architecture.md](../architecture/ingestion-architecture.md)
