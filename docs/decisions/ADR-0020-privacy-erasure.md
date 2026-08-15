# ADR-0020 — Contact erasure: anonymise in place, keep the commercial record

**Status:** Accepted
**Date:** 2026-08-15

## Context

[ADR-0013](ADR-0013-soft-deletion-and-retention.md) stated plainly that **soft
delete is not erasure**, and named erasure a prerequisite before the first real
customer. Stage 2.5 is that moment: Stage 3 begins ingesting real people
automatically.

An audit of the Stage 2 schema found PII in more places than `contacts`:

| Location                                          | Example found in the live seed                                 |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `contacts.first_name / last_name / email / phone` | Direct, expected                                               |
| `activities.summary`                              | **`"Nadia Haddad added"`** — system-generated, embeds the name |
| `tasks.title / description`                       | **`"Call Sarah about hot water quote"`** — user-authored       |
| `opportunities.title`                             | May contain a person's name                                    |
| `acquisitions.channel_detail`, `metadata`         | May be linkable                                                |

The second row is the important one: erasing `contacts` alone would leave the
person's name scattered through their own timeline. Any erasure design that
only clears the obvious columns is a compliance failure that _looks_ complete.

## Decision

### 1. Anonymise in place; do not cascade-delete

Deleting the contact would cascade to acquisitions, opportunities, tasks and
activities — destroying the commercial record. Revenue, win/loss history and
channel performance are **business facts about the workspace**, not personal
data about the individual, and a business is entitled (often required) to keep
them.

So erasure replaces identity with a **tombstone** and leaves the commercial
shape intact:

```
Contact       first/last name → 'Erased', '<contact>'   email/phone → NULL
              erased_at, erased_by_user_id set
Acquisition   source_type, platform, confidence, UTM, timestamps KEPT
              channel_detail, metadata, referrer_origin → NULL
              landing_path KEPT (a page path, not a person)
Opportunity   value, currency, stage, status, dates KEPT
              title → 'Erased opportunity'
Task          status, priority, dates KEPT
              title → 'Erased task', description → NULL
Activity      type, occurred_at, actor_type KEPT
              summary → a type-derived neutral phrase, detail → NULL
Audit         unchanged — already identifiers only, by design
```

Attribution still works after erasure: "12 leads from organic search, 3 became
customers, $14k" survives intact. Only the _who_ is gone.

### 2. Erasure is irreversible, and says so

No tombstone-to-original path exists. The values are overwritten, not moved
aside. That is the point.

### 3. It requires controlled escalation, shared with merge

`activities` has no UPDATE policy — the absence is what makes the timeline
append-only. Erasure must nonetheless rewrite `summary`.

Same mechanism as [ADR-0019](ADR-0019-contact-merge.md) §4: a narrow UPDATE
policy gated on the transaction-local flag `app.lifecycle_operation`, which is
set **only** inside `SECURITY DEFINER` functions that pin `search_path` and
re-verify the workspace. Ordinary code never sets it; code that does is
conspicuous and greppable. Both functions write audit records.

### 4. A distinct, admin-only capability

`workspace:crm:contacts:erase`, **owner and admin only**, and separate from
`contacts:archive`. The UI requires typing a confirmation phrase — not because a
typed phrase is a security control, but because it forces the operator to stop
and read what they are about to do.

### 5. The audit record must not contain what was erased

Erasure writes `crm.contact.erased` with the workspace, actor, opaque contact
id, timestamp and **counts** of affected rows. It records that erasure happened,
never what was removed. An audit trail that preserves the erased name defeats
the erasure.

### 6. Backups are explicitly out of scope, and documented

Erasure clears the **live database**. It does not reach into backups, and
claiming otherwise would be false.

Since no production backup system exists yet, no deletion job is invented for
one. What is written down instead is the obligation:

- backups expire on their retention schedule; erased data persists inside them
  until then;
- **restoring a backup requires replaying erasure requests before the restored
  data returns to service** — so an erasure log must survive the restore;
- `erasure_requests` therefore records the contact id and timestamp of every
  erasure, permanently, with no PII, precisely so a restore can replay them.

Detail in [data-lifecycle.md](../security/data-lifecycle.md).

### 7. Free-text is the standing risk

Today's free text is mostly system-generated and its shape is known. The moment
user-authored notes exist at scale, erasure cannot reliably find a name typed
mid-sentence.

The rule going forward: **structured fields for identity, free text for
context.** Where free text may hold PII, it is nulled on erasure rather than
pattern-matched — a regex that misses one occurrence is worse than a field that
is simply cleared.

## Alternatives considered

**Hard-delete the contact and cascade** — destroys the commercial record the
business is entitled to keep, and would silently delete revenue history.

**Pseudonymise with a reversible key** — a mapping table that reverses
pseudonymisation is not erasure; it is encryption with the key next to the lock.

**Regex-scrub free text for the erased name** — misses variants, nicknames and
partial matches, and would leave PII while reporting success. Nulling is honest.

**Erase asynchronously via a job queue** — no queue exists; inventing a
background job that does nothing would be worse than a synchronous transaction
that demonstrably works.

## Consequences

### Positive

- A real, testable erasure path before real customer data arrives.
- Attribution and revenue history survive.
- Verifiable: search by old name, email and phone all return nothing.

### Negative

- Irreversible.
- Backups remain a documented gap until a backup system exists.
- Some non-personal context is lost with the free text that is nulled
  (a task's description goes, not just the name inside it) — a deliberate trade
  of usefulness for certainty.

## Revisit when

- A backup system exists → implement restore-time replay of `erasure_requests`.
- User-authored notes become common → revisit the free-text rule.
- A jurisdiction imposes a specific retention obligation that conflicts.

## Related

- [ADR-0013](ADR-0013-soft-deletion-and-retention.md) · [ADR-0019](ADR-0019-contact-merge.md)
- [security/data-lifecycle.md](../security/data-lifecycle.md)
