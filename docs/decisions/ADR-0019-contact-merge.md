# ADR-0019 — Contact merge: forward-only, previewed, transactional

**Status:** Accepted
**Date:** 2026-08-15
**Context as of this date:** Stage 2.5. The CRM detects duplicate candidates
but cannot resolve them. Automated ingestion (Stage 3) will multiply duplicates,
so this must exist before it starts.

## Context

[ADR-0015](ADR-0015-contact-identity-and-deduplication.md) established that
deduplication **reports** and never merges automatically, because merging two
real people is destructive and shared mailboxes (`office@`, `info@`) are common
in the target segment. That decision stands. What was missing is the human-driven
resolution path.

Four foreign keys reference `contacts`, all `ON DELETE CASCADE`:
`acquisitions`, `opportunities`, `tasks`, `activities`. A merge must re-home all
four, atomically, without losing the historical fact that a consolidation
happened.

## Decision

### 1. Merge is forward-only. There is no unmerge.

A true unmerge requires recording, per row, which contact originally owned it,
then reversing field-conflict resolutions that a human made by hand. That is a
substantial amount of machinery whose correctness could only be established by
using it — and a half-working undo on customer data is worse than none, because
it invites the destructive action it cannot actually reverse.

Instead the operation is made **safe to get right the first time**:

- a **preview** computes the exact blast radius with no mutation;
- an explicit confirmation is required;
- the merged contact is **never hard-deleted** — it becomes a tombstone
  pointing at the survivor, so the audit trail and any external reference
  remain resolvable;
- an immutable audit event and a timeline activity are written.

Recorded plainly so nobody later assumes an undo exists.

### 2. The merged contact becomes a redirect tombstone

```
contacts.merged_into_contact_id  → the survivor
contacts.merged_at
contacts.merged_by_user_id
```

A merged contact is excluded from lists and search (like a soft delete) but is
**not** soft-deleted — the two states are distinct and mean different things.
Fetching a merged contact's id returns HTTP **301-equivalent semantics** at the
API layer: a structured `{ mergedInto: <id> }` response rather than a 404, so a
bookmarked link or an external system's stored id resolves rather than breaking.

Chosen over a 404 because the id was valid and the record still exists — telling
the caller _where it went_ is strictly more useful and leaks nothing (the caller
already held the id).

### 3. One transaction, or none of it

```
validate survivor and duplicate are distinct, same workspace, live, not merged
  → re-home acquisitions, opportunities, tasks, activities
    → resolve field conflicts (survivor wins unless explicitly overridden)
      → re-point company association if survivor has none
        → write activity + audit
          → mark duplicate as merged
```

Any failure rolls the whole thing back. A half-merged CRM — a contact whose
deals moved but whose timeline did not — is precisely the state this shape
prevents.

### 4. Re-homing `activities` needs controlled escalation

`activities` deliberately has **no UPDATE policy**; with RLS enabled, the
absence of a policy is what makes the timeline append-only
([ADR-0014](ADR-0014-activity-vs-audit.md)). Merge must nonetheless re-point
`contact_id`.

Three options were considered:

| Option                                             | Rejected because                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Add a general UPDATE policy to `activities`        | Reopens history mutation for all code, permanently, to serve two operations   |
| Run merge as a `BYPASSRLS` role                    | A very large hammer, and it disables tenant isolation for the whole operation |
| **GUC-gated policy + `SECURITY DEFINER` function** | **Chosen**                                                                    |

A narrow UPDATE policy permits the change only when a transaction-local flag
`app.lifecycle_operation` is set to a known value, and that flag is set **only**
inside the `SECURITY DEFINER` functions `crm_merge_contacts` and
`crm_erase_contact`. Those functions pin `search_path` and re-verify the
workspace themselves.

**What this does and does not guarantee**, stated honestly: it makes accidental
history mutation impossible — no ordinary code path sets the flag — and makes
deliberate mutation conspicuous and greppable. It is not a defence against a
developer who sets the flag on purpose, and nothing at the application layer
would be. The real control is that the two functions are the only sanctioned
entry points and both write audit records.

### 5. Field conflicts: survivor wins, with explicit override

The survivor's non-null values are kept. Where the survivor has a NULL and the
duplicate has a value, the duplicate's value fills it — that is a strict gain
with no information loss.

For genuine conflicts (both non-null and different), the survivor wins **unless
the caller explicitly names the field and the value to take**. Values are never
concatenated: `sarah@a.test; sarah@b.test` is not an email address. Multi-value
support (several emails per contact) is a separate future feature, not
something to fake here.

### 6. Merge is a distinct capability

`workspace:crm:contacts:merge`, granted to **admin and owner only**.

Ordinary edit permission must not imply destructive identity consolidation.
A `member` who can fix a typo should not be able to irreversibly fold two
customers into one.

## Alternatives considered

**Automatic merge on exact match** — rejected in ADR-0015 and still rejected.

**Hard-delete the duplicate** — rejected: breaks every stored reference, and
destroys the evidence that a consolidation happened.

**Soft-delete the duplicate instead of a merge tombstone** — rejected:
`deleted_at` means "removed from my list" and `merged_into_contact_id` means
"this person is that person". Conflating them loses the redirect and makes
"why did this contact vanish?" unanswerable.

**Full unmerge** — rejected, §1.

## Consequences

### Positive

- Duplicates are resolvable before automated ingestion multiplies them.
- The blast radius is visible before anything changes.
- Old ids keep resolving.
- History is preserved, and the consolidation itself is recorded.

### Negative

- **No undo.** Mitigated by preview + confirmation + restricted capability.
- Two "inactive" contact states (deleted, merged) that queries must exclude.
  Handled centrally in the repository layer rather than per call site.
- The GUC-gated escalation is a moving part that must be understood before
  touching `activities`.

## Revisit when

- Multi-value email/phone support arrives → conflict resolution can keep both.
- Merge volume justifies a bulk "merge all obvious duplicates" flow — which
  would need a much stronger confidence model first.

## Related

- [ADR-0015](ADR-0015-contact-identity-and-deduplication.md) — detection
- [ADR-0020](ADR-0020-privacy-erasure.md) — shares the escalation mechanism
- [ADR-0014](ADR-0014-activity-vs-audit.md) — why activities are append-only
