# 0009 — Designing merge, erasure and ingestion before writing any of them

**Date:** 2026-08-15 · **Stage:** 2.5

## Objective

Decide the shape of contact merge, PII erasure, automated ingestion, custom
fields, CSV import and MFA — **before** any of them was implemented. Each one
is expensive to reverse once real customer data exists, and Stage 3 begins
putting real people into the CRM automatically.

## Initial state

Stage 2 complete at `6ad1ae0`: a tenant-safe, provenance-aware CRM with nine
tables, RLS on all of them, and 264 tests. What it could not do was **correct
or remove** the data it recorded. [ADR-0013](../decisions/ADR-0013-soft-deletion-and-retention.md)
had said so plainly — "soft delete is not erasure" — and named erasure a
prerequisite before the first real customer.

## Investigation

Two findings from reading the Stage 2 schema and its seed data changed the
design before a line was written.

### 1. `activities.summary` contains direct PII, and it is system-generated

The seed contains `"Nadia Haddad added"`. Task titles contain
`"Call Sarah about hot water quote"`. Both are written by our own services from
templates, so the PII is not incidental — it is structural.

Any erasure design that cleared only `contacts` would leave the person's name
scattered through their own timeline while reporting success. That is worse
than not having erasure, because it looks like compliance.

### 2. `activities` has no UPDATE policy, and that absence IS the control

With RLS enabled, an operation with no matching policy is denied. The missing
policy is what makes the timeline append-only
([ADR-0014](../decisions/ADR-0014-activity-vs-audit.md)) — a property worth
keeping. But merge must re-point `contact_id` and erasure must rewrite
`summary`.

So both operations needed a deliberate, narrow escalation, designed rather
than improvised.

## Decisions

Six ADRs, written before implementation:

1. **[ADR-0019](../decisions/ADR-0019-contact-merge.md) — merge is
   forward-only.** No unmerge. A true unmerge needs per-row provenance of which
   contact originally owned each record plus a reversal of every field decision
   a human made by hand; a half-working undo on customer data is worse than
   none, because it invites the destructive action it cannot actually reverse.
   The mitigation is a preview computing the exact blast radius, an explicit
   confirmation, and a redirect tombstone rather than a deletion.

2. **[ADR-0020](../decisions/ADR-0020-privacy-erasure.md) — anonymise in place;
   keep the commercial record.** Cascade-deleting the contact would destroy
   revenue and channel history, which is a business fact about the workspace
   rather than personal data about the individual. After an erasure, "12 leads
   from organic search, 3 became customers, $14k" still answers. "Who was the
   third?" does not.

3. **[ADR-0021](../decisions/ADR-0021-ingestion-and-idempotency.md) — one
   ingestion boundary with receipts.** Keyed per `(workspace, source_system)`
   because third-party ids are not globally unique: two form providers can both
   emit `submission_1`, and a global key would silently discard a real lead as
   a duplicate of an unrelated one. Receipts store a digest, never the payload.

4. **[ADR-0022](../decisions/ADR-0022-custom-field-storage.md) — typed
   definitions, relational values.** The JSONB blob is rejected specifically
   because **erasure cannot enumerate it**. That, not validation, is the
   deciding argument.

5. **[ADR-0023](../decisions/ADR-0023-csv-import.md) — validate everything,
   then write in chunks.** And therefore: a partially-successful import is
   possible and must be reported honestly with row numbers, rather than rounded
   to success or failure.

6. **[ADR-0024](../decisions/ADR-0024-multi-factor-authentication.md) — TOTP
   first, passkeys next, SMS never.** Decided now so Stage 2.5's session and
   notifier work is built to fit it; implementation gated on the first external
   production tenant. SIM-swap is a routine attack against small-business
   owners, so SMS is closed off permanently rather than deprioritised.

### The escalation mechanism

Four layers, so that merge and erasure can do exactly what they need and
nothing else:

1. a transaction-local flag, `app.lifecycle_operation`;
2. an UPDATE policy on `activities` requiring it;
3. a `BEFORE UPDATE` trigger restricting **which columns** may change,
   differently for merge (re-home only) and erasure (redact only);
4. two `SECURITY DEFINER` functions as the only sanctioned setters.

**What it guarantees, stated honestly in the ADR:** it makes accidental history
mutation impossible and deliberate mutation conspicuous and greppable. It is
**not** a defence against a developer who sets the flag on purpose, and nothing
at the application layer would be.

## Alternatives considered

| Rejected                                        | Why                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| A general UPDATE policy on `activities`         | Reopens history mutation for all code, permanently, to serve two operations            |
| Running merge as a `BYPASSRLS` role             | Disables tenant isolation for the whole operation — a very large hammer                |
| Full unmerge                                    | Correctness could only be established by using it on real customer data                |
| Hard-delete on erasure                          | Destroys revenue history the business is entitled, often required, to keep             |
| Reversible pseudonymisation                     | A mapping table that reverses it is encryption with the key next to the lock           |
| Regex-scrubbing free text for the name          | Misses variants and partial matches, leaves PII while reporting success                |
| `contacts.custom_data JSONB`                    | Erasure cannot enumerate it — the exact shadow PII store to avoid                      |
| One column per custom field                     | Runtime `ALTER TABLE` on a shared multi-tenant table, on a customer's behalf           |
| Global idempotency keys                         | Third-party ids collide; costs one column to remove the whole class                    |
| Returning the original result on a key conflict | Hides a real integration bug and can attach one person's data to another's acquisition |

## Files created

`docs/decisions/ADR-0019` … `ADR-0024`, and the index in
`docs/decisions/README.md` — which was also backfilled with 0011–0018, added
during Stage 2 without ever being listed.

## Architecture impact

None yet, by design. This entry is the decision record; 0010 and 0011 are the
implementation.

## Result

Six decisions made with evidence, before the code that depends on them. The two
findings above would each have caused a rewrite if discovered afterwards.

## Remaining work

Implementation ([0010](0010-lifecycle-implementation.md)), the interface and
password reset ([0011](0011-lifecycle-interface-and-reset.md)).
