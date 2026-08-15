# ADR-0012 — Acquisition provenance model

**Status:** Accepted
**Date:** 2026-08-15

## Context

Growth OS exists to answer _"which acquisition work produced revenue?"_. That
question is only answerable if provenance is captured **at the moment of
acquisition**, from the source that actually knows it. It cannot be
reconstructed afterwards.

The hard part is not storing fields. It is being honest about which fields are
**trustworthy**, which are **guessed**, and which are **frequently absent** —
because an attribution report built on silently-inferred data is worse than no
report. It looks authoritative and is wrong.

## Decision

### 1. Provenance lives on `acquisitions`, never on `contacts`

A person can arrive many times from many places. Provenance is a property of
the **arrival**, not of the person.

### 2. Every acquisition declares the trust level of its own data

```ts
type ProvenanceConfidence =
  | 'declared' // the source system told us authoritatively (GSC, Ads, our own form)
  | 'derived' // computed from browser signals (referrer, UTM) — spoofable, often absent
  | 'inferred' // our own heuristic. Must be visibly labelled wherever displayed
  | 'manual'; // a human typed it. Trust the human, but record that it was typed
```

This is the field that makes the difference between an attribution report and a
guess. It is **required**, so an ingestion path cannot omit it, and it is
carried through to the UI.

### 3. Field taxonomy — classified by where the data comes from

| Field              | Class             | Reliability                                     |
| ------------------ | ----------------- | ----------------------------------------------- |
| `source_type`      | enum, required    | Always present; `unknown` is a legitimate value |
| `source_platform`  | enum, required    | `unknown` is legitimate                         |
| `landing_page`     | derived           | Path only — **query string stripped** (see §5)  |
| `referrer`         | derived           | Absent under many privacy settings; origin only |
| `utm_*` (5 fields) | derived           | Attacker/user-editable; frequently absent       |
| `gclid` / `fbclid` | derived           | Strong signal when present; opaque to us        |
| `search_query`     | **declared only** | **See §4 — the most abusable field in any CRM** |
| `captured_at`      | declared          | Server clock, never the client's                |
| `channel_detail`   | declared          | e.g. the tracked phone number, the form name    |
| `metadata`         | validated jsonb   | Bounded schema, not a junk drawer (§6)          |

### 4. `search_query` is nullable and must NEVER be inferred

This is the single most important rule in this document.

Organic search engines have not passed the query in the referrer since 2011
("not provided"). The keyword is only knowable from an authenticated
integration — Search Console, or an Ads platform's own click data.

Therefore:

- `search_query` is **NULL** unless a source system explicitly told us.
- It may only be written with `provenance_confidence = 'declared'`.
- Nothing may derive it from the landing page, the campaign name, or the
  content of the page the visitor saw.

Inventing a keyword would fabricate the exact number this product's entire
value proposition rests on. It is a Principle 3 violation of the most damaging
possible kind, and the schema is shaped so it cannot happen by accident.

### 5. Landing page stores the path, and strips the query string

Query strings routinely contain personal data (email addresses in
click-through links, session identifiers, prefilled form values). Storing the
full URL would silently import PII into a column nobody thinks of as personal.

The path is what attribution needs. UTM parameters are extracted into their own
typed columns first, then the rest of the query string is discarded.

### 6. `metadata` is a validated shape, not a junk drawer

Parsed by a Zod schema with a bounded key set, a size cap and no nested
free-text. An unrestricted JSON column becomes the place PII goes to hide from
retention and deletion policies — and it is never audited, because nobody knows
what is in it.

### 7. First-touch and last-touch are derived, not stored

First touch is `MIN(captured_at)` per contact; last touch is `MAX`. Not
denormalised onto the contact.

Storing them creates two sources of truth that must be kept in sync on every
insert, and they drift the first time a backfill or an import runs. The
denormalisation trigger is named in
[data-architecture.md](../architecture/data-architecture.md): when the contacts
list query exceeds its latency budget at realistic volume.

## Alternatives considered

### A — A single `source` string on `contacts`

**Rejected:** loses every repeat visit, and cannot express confidence. This is
the shape most small CRMs ship and the reason their attribution reports are not
trusted.

### B — A generic `metadata` JSON blob for all provenance

_Attractive:_ accepts anything from any future integration without a migration.

**Rejected:** unqueryable without JSON operators on every read, un-indexable in
practice, and impossible to enforce a retention policy over. Typed columns for
the fields we know, a _bounded_ blob for the rest.

### C — Full URL in `landing_page`

**Rejected:** imports PII from query strings into a column that no retention
policy covers, as above.

### D — Infer `search_query` from campaign or page content

**Rejected** — emphatically. See §4.

### E — Store first/last touch on the contact now

**Rejected as premature.** Two sources of truth, drift on import, and no
measured need. Trigger recorded instead.

## Consequences

### Positive

- Attribution (Stage 15) can be built without touching customer data.
- Every figure can be rendered with its confidence, so a report never
  overstates what is known.
- SEO, voice, forms, ads and imports all write the same shape.
- PII does not leak in through the provenance path.

### Negative

- Ingestion paths must supply `source_type`, `source_platform` and
  `provenance_confidence`. Deliberate friction: the alternative is an
  `unknown`-shaped hole discovered at Stage 15.
- The contacts list needs a lateral join for "source".
- `search_query` will be NULL for most organic acquisitions. That is the truth,
  and the UI says "not provided" rather than blank.

### Risks and mitigations

| Risk                                                | Mitigation                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| An integration writes `inferred` data as `declared` | Confidence is a required argument on the service, reviewed per integration; unit tests assert the mapping |
| UTM spoofing skews reports                          | Confidence is `derived`; documented as untrusted in `data-architecture.md`                                |
| `metadata` becomes a dumping ground                 | Bounded Zod schema, size cap, no nested free text                                                         |

## Revisit when

- Search Console lands (Stage 5) — the first real `declared` `search_query`.
- Call tracking lands (Stage 10) — `channel_detail` carries the tracked number.
- Attribution modelling begins (Stage 15) — first-touch denormalisation may
  become justified by measurement.

## Related

- [ADR-0011](ADR-0011-crm-domain-model.md)
- [architecture/data-architecture.md](../architecture/data-architecture.md)
- [product/terminology.md](../product/terminology.md)
