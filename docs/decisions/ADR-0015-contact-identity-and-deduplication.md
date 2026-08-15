# ADR-0015 — Contact identity, normalisation and deduplication

**Status:** Accepted
**Date:** 2026-08-15

## Context

The same person will enter Growth OS repeatedly through different channels: a
form as `Sarah.Mitchell@Example.com`, a tracked call as `0412 345 678`, a voice
AI conversation as `+61 412 345 678`. Without normalisation these produce three
contacts, and the timeline — the product's most valuable surface — fragments.

Automatic merging is the obvious fix and the dangerous one: merging two real
people is **destructive and effectively irreversible**.

## Decision

### 1. Normalise on write, into dedicated columns

`email_normalised` and `phone_normalised` are stored alongside the originals.
The user's formatting is preserved for display; matching uses the normalised
form.

**Email:** `trim` + `lowercase`. Nothing else.

Explicitly **not** done: stripping dots, stripping `+aliases`, or any
provider-specific rewriting. `first.last@gmail.com` and `firstlast@gmail.com`
are the same Gmail mailbox but different addresses at most other providers —
and `sarah+plumbing@example.com` may be a deliberately distinct contact route.
Applying Gmail's rules universally silently merges different people.

**Phone:** parsed to **E.164** via `libphonenumber-js`, using a region hint.
Unparseable input stores `NULL` in `phone_normalised` and keeps the raw value —
never a mangled guess.

### 2. Phone region comes from the workspace, not a global constant

`workspaces.default_phone_region` (ISO 3166-1 alpha-2, default `AU` for the
current customer base, **configurable per workspace**).

`0412 345 678` is a valid mobile in Australia and a valid landline in several
other countries. Hard-coding `AU` would silently corrupt every non-Australian
workspace, and would be discovered only after data existed.

### 3. Deduplication reports candidates. It never merges automatically.

On create, the service checks for an existing contact by exact
`email_normalised` or exact `phone_normalised` within the workspace, and returns
`{ contact, duplicateOf }` — the caller decides.

**Names are never used for matching.** Two "James Carter"s in a plumbing
company's database are two customers. Name similarity is a _hint for a human_,
never grounds for machine action.

### 4. Uniqueness is advisory, not enforced

No unique constraint on `email_normalised`. Two family members legitimately
share `office@abcplumbing.test`, and imports contain duplicates that must be
loadable and then reconciled.

A partial index (`WHERE deleted_at IS NULL`) supports fast lookup without
forbidding the duplicate.

### 5. Merge is designed, not built

Stage 2 surfaces "this may already exist". The merge workflow — choose a
survivor, re-point acquisitions/opportunities/tasks/activities, record a
`contact.merged` activity, retain a reversal window — is documented in
[crm-architecture.md](../architecture/crm-architecture.md) and deferred. A
half-built destructive merge is worse than none.

## Alternatives considered

### A — Automatic merge on exact email match

_Attractive:_ clean data, no user decision.

**Rejected:** shared mailboxes (`info@`, `office@`) are extremely common in the
target segment — small trades businesses. Auto-merging would silently combine a
business owner and their receptionist into one contact, and there is no undo.

### B — Fuzzy matching on name + email similarity

**Rejected:** false positives merge real people. Levenshtein distance has no
idea that "James Carter" and "Jamie Carter" are siblings.

### C — Unique constraint on `(workspace_id, email_normalised)`

**Rejected:** makes legitimate shared addresses unrepresentable and makes bulk
import fail on the first duplicate instead of loading and flagging.

### D — Hand-rolled phone normalisation (strip non-digits, prefix country code)

_Attractive:_ no dependency.

**Rejected:** correct E.164 conversion needs per-region national-prefix and
length rules — trunk `0` handling differs by country, and some regions have
variable-length numbers. This is a solved problem with a maintained library, and
getting it wrong corrupts the matching key silently. Dependency justified per
[dependency-policy.md](../engineering/dependency-policy.md); it is server-side
only, so it costs the browser nothing.

## Consequences

### Positive

- Repeat visitors converge onto one timeline without destructive automation.
- Non-Australian workspaces are correct from day one.
- Imports load fully, then flag duplicates for review.

### Negative

- Duplicates can exist. Deliberate: recoverable, unlike a wrong merge.
- `libphonenumber-js` (~150 KB) is a server-side dependency.
- Users must resolve duplicates manually until merge ships.

### Risks and mitigations

| Risk                                          | Mitigation                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Duplicate accumulation degrades the timeline  | Candidate surfaced at creation; merge is the named Stage 3 follow-up             |
| Wrong region corrupts `phone_normalised`      | Per-workspace setting; raw value always retained so re-normalisation is possible |
| Normalisation drift between create and search | One shared module used by both; unit-tested                                      |

## Revisit when

- Duplicate rate becomes a support burden → build merge.
- A workspace needs multiple regions → per-contact region hint.

## Related

- [ADR-0011](ADR-0011-crm-domain-model.md)
- [engineering/dependency-policy.md](../engineering/dependency-policy.md)
