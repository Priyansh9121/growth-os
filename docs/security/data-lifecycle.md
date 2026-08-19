# Data Lifecycle

**Status:** Implemented (Stage 2.5)
**Last verified:** 2026-08-15

How customer data enters Growth OS, how it is corrected, and how it leaves.

Everything below is enforced by code and asserted by tests, or is explicitly
marked as a gap. Nothing here describes an intention.

---

## 1. Where personal data lives

The complete list. It is complete because erasure depends on it being complete
— a location missing from this table is a location erasure does not reach.

| Table                  | Personal data                                                                           | Cleared by erasure                      |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| `contacts`             | `first_name`, `last_name`, `email`, `email_normalised`, `phone`, `phone_e164`           | Yes — replaced with a tombstone         |
| `acquisitions`         | `channel_detail`, `metadata`, `referrer_origin`, `gclid`, `fbclid`                      | Yes                                     |
| `acquisitions`         | `source_type`, `source_platform`, `confidence`, UTM set, `landing_path`, `search_query` | **No** — see §3                         |
| `opportunities`        | `title` (may embed a name)                                                              | Yes — replaced                          |
| `tasks`                | `title`, `description` (user-authored free text)                                        | Yes — replaced and nulled               |
| `activities`           | `summary`, `detail`, `metadata` (system-generated, embeds names)                        | Yes — replaced and nulled               |
| `contact_field_values` | Anything the workspace defined                                                          | Yes — rows deleted                      |
| `contact_tags`         | Which labels were applied to a person                                                   | Yes — rows deleted                      |
| `companies`            | `name`, `phone`, `website_host`                                                         | **No** — a business, not a person       |
| `users`                | `email`, `name`                                                                         | Out of scope — operators, not customers |
| `audit_events`         | `ip_address`, `user_agent`                                                              | Separate retention — see §7             |

**Not personal data, and deliberately empty of it:** `ingestion_receipts`
(digest only), `import_batches` (counts and column names only),
`erasure_requests` (ids and counts only).

### The one that is easy to miss

`activities.summary` is **system-generated and still contains names** —
`"Nadia Haddad added"`, `"Task created — Call Sarah about the hot water
quote"`. So does `tasks.title`, which is user-authored.

Worse, both are reachable **without a `contact_id`**: `tasks.contact_id` and
`tasks.opportunity_id` are independently nullable, so a task raised against a
deal names the person while pointing only at the deal. Erasure therefore
reaches tasks and activities through the contact's **opportunities and
acquisitions** as well as directly.

That was found by running an erasure against a fixture and searching for the
name afterwards, not by reading the code. It is why the test asserts by
**searching**, in `packages/crm/src/lifecycle.integration.test.ts`:

```ts
expect(await countTracesOf(owner, 'Nadia')).toBe(0);
```

A test written against the implementation would pass even if the
implementation missed a column. This one cannot.

---

## 2. How data enters

One boundary: `ingestAcquisition` in `packages/crm/src/ingestion/service.ts`
([ADR-0021](../decisions/ADR-0021-ingestion-and-idempotency.md)). Website
forms, tracked calls, voice AI, ad-platform webhooks, the public API and CSV
import all call it.

| Control                | Where                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| Identity normalisation | `normaliseEmail` / `normalisePhone`, shared with manual entry and search   |
| Provenance integrity   | `assertProvenanceIntegrity`, plus a database trigger                       |
| Idempotency            | `ingestion_receipts`, unique on `(workspace, source_system, external_key)` |
| Anti-abuse seam        | `trust` on the input — decided in the adapter, never in CRM logic          |
| Tenant isolation       | `withTenantTransaction` + RLS on every table it touches                    |

**Retries are safe and events are not double-counted.** A repeated
`(source_system, external_key)` with the same digest returns the original ids
and publishes **nothing** — re-emitting would let a retrying webhook inflate
downstream counters even though the database correctly refused the second row.
A repeated key with a _different_ digest is a `ConflictError`, never a silent
replay.

### CSV import

The file is parsed **in memory** and never written to disk
([ADR-0023](../decisions/ADR-0023-csv-import.md)). There is no upload
directory to leak, scan, or forget to clean up, and no path for a customer CSV
to be committed by accident.

| Risk                     | Control                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| Oversized upload         | 5 MB / 10,000 rows, checked at `Content-Length`, `File.size` and decode |
| Malformed encoding       | `TextDecoder(fatal: true)` — rejects rather than mangling               |
| Arbitrary column targets | Mapping resolves through the closed `IMPORT_FIELD_TARGETS` enum         |
| Row values in logs       | Issue messages carry field names and rules, never values                |

⚠️ **Formula injection on export is NOT controlled, because there is no export.**

This table listed `neutraliseCsvFormula` as the live control for it. That was
wrong in the direction that matters: the function exists and is tested, and it
**has no production caller** — verified in
[dev log 0024](../development-log/0024-three-claims-the-code-does-not-keep.md),
where the only references are its definition and its own test file.
`packages/crm/src/import/csv.ts` reads a file and never writes one.

There is nothing to control today, because nothing exports. **The row is removed
rather than softened**: a Risk/Control table is read as an inventory of what is
in force, and an entry naming a function that never runs is how the next author
concludes the problem is already solved.

When an export is built it must call `neutraliseCsvFormula` — it will not apply
itself — and this row goes back. Note also that the guard is anchored at index
0: measured, a leading space, BOM, NBSP or LF leaves a dangerous value
unprefixed. Whether a spreadsheet still evaluates the formula after those
characters **has not been measured by this project** and must not be assumed in
either direction.

Imported provenance is always `source_type = import`, `confidence = manual`. A
"Source" column becomes `channel_detail` — a spreadsheet saying "Google" is
someone's recollection, not a measurement.

---

## 3. Erasure

`crm_erase_contact` — [ADR-0020](../decisions/ADR-0020-privacy-erasure.md).

**Anonymise in place; do not cascade-delete.** Deleting the contact would
cascade to acquisitions, opportunities, tasks and activities, destroying
revenue and channel history — which is a business fact about the workspace, not
personal data about the individual.

After an erasure, _"12 leads from organic search, 3 became customers, $14k"_
still answers correctly. _"Who was the third one?"_ does not.

### Why `gclid` and `fbclid` are cleared but `utm_campaign` is not

A click identifier resolves back to an individual at the ad platform, which
makes it personal data however much it looks like plumbing. A campaign name
describes a campaign. Aggregate attribution survives; the pseudonymous
identifier does not.

`search_query` is retained: it is a phrase typed into a search engine, only
ever populated when a source system declared it, and it is the single number
this product's value rests on. Flagged here as the one retained field where a
customer could conceivably have typed something identifying about themselves —
revisit if a real case appears.

### It is irreversible

Values are overwritten, not moved aside. There is no restore path, and the UI
says so before the operator confirms.

### Access

`workspace:crm:contacts:erase` — **owner and admin only**, separate from
`contacts:archive`. The UI requires typing a confirmation phrase, which is
**not a security control** — anyone who can reach the button can type five
letters — but a deliberate pause before something with no undo.

---

## 4. ⚠️ Backups: the known gap

**Erasure clears the live database. It does not reach into backups.**

Stated plainly because the alternative is a compliance claim that is false.

No production backup system exists yet, so no deletion job is invented for one.
What is implemented instead is the **obligation**:

- `erasure_requests` records the workspace, contact id, actor, counts and
  timestamp of every erasure, **permanently and PII-free**;
- `contact_id` in that table deliberately has **no foreign key**, so the log
  stays replayable against a restored database whose contact rows are a
  different generation;
- the table is append-only under RLS — no UPDATE and no DELETE policy — because
  the whole value of it is that it cannot be quietly edited to forget that
  someone asked to be forgotten.

### The restore runbook, for when backups exist

1. Restore to a **staging** database, never straight into service.
2. Read `erasure_requests` from the **live** database (it is the newer record).
3. Replay `crm_erase_contact` for every entry against the restored database.
4. Verify with `countTracesOf` for a sample of erased identifiers.
5. Only then promote.

Until a backup system exists, this section is a specification, not a procedure.
It is marked as such on purpose.

---

## 5. Merge

`crm_merge_contacts` — [ADR-0019](../decisions/ADR-0019-contact-merge.md).

**Forward-only. There is no unmerge.** A half-working undo on customer data is
worse than none, because it invites the destructive action it cannot actually
reverse. What exists instead: a preview computing the exact blast radius with
no mutation, an explicit confirmation, a redirect tombstone rather than a
deletion, and an audit record written inside the same transaction.

A merged contact's id still resolves — the API and the UI redirect to the
survivor rather than returning 404. The id was valid and the record still
exists; telling the caller where it went leaks nothing they did not already
hold.

Merged and erased contacts are excluded from the partial identity indexes, so
neither can be matched by deduplication or ingestion. Matching a tombstone
would attach new acquisitions to a redirect instead of to the real person.

---

## 6. The escalation mechanism, and its honest limits

`activities` has **no UPDATE policy**, and that absence is what makes the
timeline append-only ([ADR-0014](../decisions/ADR-0014-activity-vs-audit.md)).
Merge must nonetheless re-point `contact_id`, and erasure must clear a summary
containing a name. Four layers make that possible without opening the door:

1. a transaction-local flag, `app.lifecycle_operation`;
2. an UPDATE policy on `activities` requiring it;
3. a `BEFORE UPDATE` trigger restricting **which columns** may change,
   differently for merge (re-home only) and erasure (redact only);
4. two `SECURITY DEFINER` functions as the only sanctioned setters — pinning
   `search_path`, re-verifying the workspace, and clearing the flag on the way
   out.

The acquisitions immutability trigger gained two narrow exemptions rather than
one blanket bypass. `source_type`, `source_platform`, `confidence`,
`captured_at`, the UTM set and `search_query` stay frozen under **every** path:
a merge or an erasure must never be able to rewrite where a lead came from.

### What this does and does not guarantee

It makes accidental history mutation **impossible** — no ordinary code path
sets the flag — and makes deliberate mutation conspicuous and greppable.

It is **not** a defence against a developer who sets the flag on purpose, and
nothing at the application layer would be. The real control is that the two
functions are the only sanctioned entry points and both write audit records.

### ⚠️ SECURITY DEFINER and superusers

A `SECURITY DEFINER` function runs as its **owner**. If migrations are applied
by a superuser, RLS is inert inside these functions, because PostgreSQL exempts
superusers unconditionally.

That is why **every statement inside them carries its own explicit
`workspace_id = p_workspace` predicate** rather than leaning on the policy. The
functions are correct with or without RLS; the predicates are not redundant,
they are the control that survives.

**Operational requirement:** own the schema with a non-superuser role in any
shared environment. Same requirement as the rest of the RLS layer
([tenant-isolation.md](tenant-isolation.md)).

---

## 7. Retention

| Data                    | Retention                  | Enforced?                                   |
| ----------------------- | -------------------------- | ------------------------------------------- |
| Contacts and history    | Indefinite, until erased   | n/a                                         |
| Soft-deleted contacts   | Indefinite                 | **No purge job** — ADR-0013's known gap     |
| `ingestion_receipts`    | Indefinite                 | **No purge job** — no PII, so storage-bound |
| `import_batches`        | Indefinite                 | No PII                                      |
| `erasure_requests`      | **Permanent, by design**   | Append-only under RLS                       |
| `audit_events`          | Target 400 days            | **No purge job**                            |
| `password_reset_tokens` | 60 min live, then prunable | `pruneExpiredResetTokens`, **unscheduled**  |
| Sessions                | 30-day idle / 90-day hard  | Enforced at read time                       |

Four "no purge job" rows, all named rather than glossed. There is no job runner
yet; inventing one that does nothing would be worse than an unscheduled
function that works. `pruneExpiredResetTokens` exists and is callable; wiring
it is Stage 3 work, when `apps/worker` arrives.

---

## 8. What the operator can see

| Surface          | Who             | Contains                         |
| ---------------- | --------------- | -------------------------------- |
| Contact timeline | Every operator  | PII, by design                   |
| `audit_events`   | Admin and owner | Identifiers only, never values   |
| Erasure log      | Erasure-capable | Ids, counts, timestamps — no PII |
| Import batches   | Import-capable  | Filenames and counts — no rows   |
| Domain events    | Subscribers     | Identifiers only                 |

**No AI tool reads custom field values**, because that is where the most
sensitive and least predictable PII ends up — "Patient Type", "Case Number".
AI tools remain read-only and have no access to merge, erasure, import or
export ([ADR-0022](../decisions/ADR-0022-custom-field-storage.md)).

---

## 9. What is never logged

Enforced by the audit writer's redaction and by discipline at every call site:

CSV rows · contact names · email addresses · phone numbers · custom field
values · merge field values · erasure contents · import filenames · reset
tokens · session tokens.

The only place a raw token is ever printed is
`ConsolePasswordResetNotifier`, which the composition root **refuses to
construct in production**.

---

## 10. How to verify this document

```bash
npm run test:integration     # 34 database-layer + 36 service-layer lifecycle tests
```

The assertions that matter most:

| Property                                              | Where                               |
| ----------------------------------------------------- | ----------------------------------- |
| Erasure leaves no searchable trace of the person      | `lifecycle.integration.test.ts`     |
| Erasure reaches rows linked only via the opportunity  | `crm-lifecycle.integration.test.ts` |
| Erasure keeps deal value, stage and channel           | `crm-lifecycle.integration.test.ts` |
| A merge cannot rewrite a timeline summary             | `crm-lifecycle.integration.test.ts` |
| An erasure cannot re-point a timeline entry           | `crm-lifecycle.integration.test.ts` |
| Neither can change where a lead came from             | `crm-lifecycle.integration.test.ts` |
| An ordinary UPDATE on `activities` is still refused   | `crm-lifecycle.integration.test.ts` |
| Cross-workspace merge and erasure are refused         | `crm-lifecycle.integration.test.ts` |
| A retried ingestion creates nothing and emits nothing | `lifecycle.integration.test.ts`     |
| RLS enabled AND forced on every new table             | `crm-lifecycle.integration.test.ts` |
| The erasure log contains no PII                       | `crm-lifecycle.integration.test.ts` |

Every one runs as a **restricted, non-owner role**. A suite connected as the
migration role would pass while proving nothing.

---

## Related

- [ADR-0019](../decisions/ADR-0019-contact-merge.md) · [ADR-0020](../decisions/ADR-0020-privacy-erasure.md) · [ADR-0021](../decisions/ADR-0021-ingestion-and-idempotency.md) · [ADR-0022](../decisions/ADR-0022-custom-field-storage.md) · [ADR-0023](../decisions/ADR-0023-csv-import.md)
- [tenant-isolation.md](tenant-isolation.md) — the three isolation layers
- [ADR-0013](../decisions/ADR-0013-soft-deletion-and-retention.md) — why soft delete is not erasure
