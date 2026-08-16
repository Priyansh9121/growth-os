# Lead Capture Architecture

**Status:** Implemented (Stage 3)
**Last verified:** 2026-08-16

How an anonymous website visitor becomes a truthfully attributed CRM lead.

---

## 1. The loop

```
        CUSTOMER'S WEBSITE                     GROWTH OS
 ┌────────────────────────────┐   ┌──────────────────────────────────────┐
 │  <script embed.js>  633 B  │   │                                      │
 │        ↓ inserts           │   │                                      │
 │  ┌──────────────────────┐  │   │                                      │
 │  │  iframe → /f/<key>   │──┼───┼─→ hosted form (same renderer)        │
 │  └──────────────────────┘  │   │                                      │
 │  <script track.js>  711 B  │   │                                      │
 │        ↓ writes            │   │                                      │
 │   sessionStorage           │   │                                      │
 └────────────────────────────┘   │                                      │
              │ submit             │                                      │
              ▼                    │                                      │
   POST /api/public/forms/:key/submissions                               │
              │                    │                                      │
              ▼                    │                                      │
   ┌─────────────────────────────────────────────────────────┐           │
   │ 1  resolve_public_form(key)   → workspace  (SECURITY DEFINER) │       │
   │ 2  status · origin · rate limit · honeypot · timing     │           │
   │ 3  validate against the PUBLISHED version's fields      │           │
   │ 4  classifySource(context)    → deterministic provenance│           │
   └─────────────────────────────────────────────────────────┘           │
              │                    │                                      │
              ▼                    │                                      │
   ┌─────────────────────────────────────────────────────────┐           │
   │  ingestAcquisition(systemContext, …)    ← @growth-os/crm │           │
   │  contact · acquisition · opportunity · activity · receipt│           │
   │  ONE transaction, idempotent, RLS-scoped                │           │
   └─────────────────────────────────────────────────────────┘           │
              │                                                           │
              ▼                                                           │
   CRM  ·  pipeline  ·  timeline  ·  dashboard  ·  domain event          │
   └──────────────────────────────────────────────────────────────────────┘
```

## 2. The rule the whole design exists to keep

**`@growth-os/forms` never inserts a CRM row.**

The public endpoint is an **adapter**. It resolves, validates, classifies and
then calls `ingestAcquisition` — which owns matching, idempotency, provenance
integrity and atomicity for every channel.

A second ingestion path would mean two answers to "how is a lead
deduplicated?", and attribution would depend on which one happened to run
([ADR-0021](../decisions/ADR-0021-ingestion-and-idempotency.md)). The only rows
forms writes are its own: sites, forms, versions and submission receipts.

## 3. Domain model

| Table                      | Holds                                           | Notes                                                                                                        |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sites`                    | Workspace's web properties                      | Canonical **origin**, not a URL. Configured ≠ verified ([ADR-0029](../decisions/ADR-0029-web-properties.md)) |
| `forms`                    | Identity, public key, status, published version | One opaque 128-bit key per form                                                                              |
| `form_versions`            | An **immutable** field list and settings        | No UPDATE policy — the absence enforces it                                                                   |
| `form_submissions`         | A **receipt**, never the payload                | Outcome, ids, source, byte size                                                                              |
| `jobs`                     | Platform background work                        | Not workspace-scoped; see [worker-architecture.md](worker-architecture.md)                                   |
| `public_submission_limits` | Rate-limit counters                             | Keyed by SHA-256 of the subject. The IP is never stored                                                      |

### Why versions are immutable

A lead submitted under version 3 must not silently mean something different
after version 4 remaps a field. If "Field 2" was `phone` on Monday and
`company` on Tuesday, Monday's submission is uninterpretable by Wednesday.

Editing writes a **new** version; `form_submissions.form_version_id` records
which one a lead arrived under. "What did this form look like when that lead
came in?" therefore has an answer, which matters the first time a customer
disputes a lead's source.

### Why the field list is JSONB, and custom field values are not

Deliberately opposite decisions, so the difference is worth stating.

Custom field **values** are rows ([ADR-0022](../decisions/ADR-0022-custom-field-storage.md))
because they are queried, filtered, and must be enumerable by erasure. A form's
field **list** is read as a whole, written as a whole, versioned as a whole, and
never queried across forms. It has no independent identity, and splitting it
into rows would make an immutable snapshot a multi-table write.

The shape is still validated — `formVersionConfigSchema` parses it on the way in
**and on the way out**, so a row written by an older build either validates or
the public form fails closed.

## 4. Trust boundaries

| Boundary                  | What crosses it                                        | What is trusted                                 |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| Browser → public endpoint | Field values, a submission id, raw attribution signals | **Nothing.** All of it is untrusted input       |
| Public key → workspace    | One opaque key                                         | The key, and only through `resolve_public_form` |
| Endpoint → ingestion      | A system context with ONE capability                   | The workspace, established server-side          |
| Ingestion → database      | Tenant-scoped transaction                              | RLS applies exactly as for a human              |

### What a browser can never state

`sourceType` · `confidence` · `searchQuery` · `workspaceId`

None of these appears in `publicSubmissionSchema`, so they are stripped at the
boundary rather than validated away. The server derives provenance from raw
signals through deterministic code.

## 5. The system actor

Public ingestion runs under an explicit **capability grant** of exactly
`workspace:crm:contacts:write` — not a workspace role
([ADR-0025](../decisions/ADR-0025-system-actors.md)).

The weakest role holding that capability is `member`, which also holds
`opportunities:write`, `tasks:write`, `companies:write` and `tags:apply`.
Handing a public endpoint a role would grant it five capabilities to use one.

`actorUserId()` **throws** on a system context. Not returns null — throws, so a
service that has not been reviewed for system safety stops at the call instead
of writing a fabricated foreign key. That is not theoretical: it caught
`recordActivity` and `insertAcquisition` during Stage 3, both of which assumed a
human. Rows created by a form record `created_by_user_id = NULL` and
`actor_type = 'system'`, which is the honest answer.

## 6. Attribution

| Signal             | Source                         | Trust                                                           |
| ------------------ | ------------------------------ | --------------------------------------------------------------- |
| `landingPath`      | Tracking script, **path only** | Untrusted, re-truncated server-side                             |
| `submissionPath`   | The page the form sat on       | Untrusted                                                       |
| `referrerOrigin`   | **Origin only**                | Untrusted                                                       |
| UTM set            | Landing URL query              | Untrusted → `derived` confidence                                |
| `gclid` / `fbclid` | Landing URL query              | Untrusted → `declared`, because an ad platform minted the token |
| `sessionId`        | Generated in-browser           | Correlation only, identifies nobody                             |

**First touch wins.** The tracking script writes once per tab and never
overwrites, so a visitor who lands on `/emergency-plumber?utm_campaign=…` and
submits from `/contact` is attributed to the campaign, not to the page the form
happened to sit on. The submission page is recorded separately in the
acquisition's metadata.

### The search query guarantee

`search_query` is **never** set by this path. Not from `utm_term` (the
marketer's bid keyword, not the visitor's search), not from a Google referrer
(engines stopped passing the query in 2011), and not from a landing page. It
comes from Search Console and nothing else
([ADR-0012](../decisions/ADR-0012-provenance-model.md)).

The tracking script truncates a referrer to its origin **in the browser**, so
a legacy `?q=` never even leaves the page.

## 7. Idempotency

The client generates one submission id per form instance — not per attempt,
which is what makes a retry a retry. The server scopes it as
`website_form` / `<formId>:<submissionId>`, so two forms can legitimately
receive the same id.

| Situation                  | Result                                                     |
| -------------------------- | ---------------------------------------------------------- |
| New id                     | Ingest, write a receipt, `created`                         |
| Same id, same content      | Original ids returned, `duplicate`, **no event published** |
| Same id, different content | `ConflictError` — never a silent replay                    |

Disabling the submit button is UX. **The receipt is the concurrency control.**

## 8. What is deliberately not stored

`form_submissions` holds an outcome, ids, a classified source, a byte size and
a rejection reason. It does **not** hold what the visitor typed.

That becomes the contact, the acquisition and the opportunity, which erasure
governs. A submission archive would be a second, richer copy of every enquiry a
business ever received, sitting outside erasure's reach — exactly the shadow
PII store Stage 2.5 rejected.

## 9. Related

- [ADR-0025](../decisions/ADR-0025-system-actors.md) · [ADR-0026](../decisions/ADR-0026-public-form-resolution.md) · [ADR-0027](../decisions/ADR-0027-embed-mechanism.md) · [ADR-0028](../decisions/ADR-0028-attribution-storage.md) · [ADR-0029](../decisions/ADR-0029-web-properties.md) · [ADR-0030](../decisions/ADR-0030-worker-and-queue.md)
- [security/public-forms-threat-model.md](../security/public-forms-threat-model.md)
- [worker-architecture.md](worker-architecture.md)
