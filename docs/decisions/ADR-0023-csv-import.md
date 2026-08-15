# ADR-0023 — CSV import: validate everything, then write in chunks

**Status:** Accepted
**Date:** 2026-08-15

## Context

Import is the first bulk write path into the CRM and the first exercise of the
ingestion service ([ADR-0021](ADR-0021-ingestion-and-idempotency.md)) at
volume. It is also where a customer's existing, messy, real data arrives — with
duplicates, bad encodings and columns nobody expects.

## Decision

### 1. A staged wizard, never upload-and-write

`Upload → Map columns → Validate → Review → Import → Results`

Parsing and validating produce **no mutation**. The operator sees counts of
valid, invalid and probable-duplicate rows before anything is written. An
import that silently creates 4,000 contacts on file selection is not
recoverable by any means the product offers.

### 2. Validate the whole file first, then write in chunks

One malformed row must not discard 9,999 good ones, and a single transaction
over 10,000 rows holds locks far too long.

So: validate every row up front and report; then write valid rows in
transactional chunks of 200. A chunk that fails rolls back only itself and is
reported as failed — the rest of the import proceeds.

The honest consequence: **a partially-successful import is possible**, and the
result summary reports exactly which rows landed. That is better than an
all-or-nothing import of a 10,000-row file that fails at row 9,998, and better
than a per-row transaction that is ten thousand round trips.

### 3. Provenance is `import`, and says so

Every imported acquisition gets `source_type = 'import'` with
`confidence = 'manual'`.

If the CSV has a "Source" column, the operator may map it — and the value is
recorded as `channel_detail`, **not** promoted to `source_type`. A spreadsheet
saying "Google" is a human's recollection, not a measurement, and treating it as
declared provenance would poison attribution with the exact fabrication
[ADR-0012](ADR-0012-provenance-model.md) exists to prevent.

`search_query` can never be set by import. The schema and the trigger already
forbid it.

### 4. Idempotency: batch id plus row fingerprint

Each import creates an `import_batches` row. Each row's idempotency key is
`import:<batch_id>:<row_number>`, so a resumed or retried batch is safe.

Re-uploading **the same file as a new batch** deliberately produces a _new_
batch: the operator may genuinely intend to re-import after fixing data. What
protects them is that ingestion still matches on normalised email/phone, so
re-import updates nothing and creates acquisitions against existing contacts
rather than duplicate people — which is visible in the preview beforehand.

### 5. CSV security

| Risk                            | Control                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| Very large files                | 5 MB and 10,000 rows, enforced before parsing                        |
| Formula injection **on export** | Values beginning `= + - @ TAB CR` are prefixed with `'`              |
| Malformed encoding              | UTF-8 with BOM stripping; undecodable rows are reported, not guessed |
| Unexpected columns              | Only mapped columns are read. Unmapped are ignored                   |
| Huge fields                     | Per-field length caps, from the same Zod schemas the API uses        |
| Arbitrary column targets        | Mapping targets a **closed enum** of fields — never a column name    |

The last one matters: a mapping of `{ "Email": "email" }` resolves through a
fixed allowlist. A client cannot map a CSV column to `workspace_id`.

Formula injection is an **export** risk, and the export path applies the same
prefixing — a cell reading `=cmd|'/c calc'!A1` is a spreadsheet exploit, not a
name.

### 6. Uploads are never written to disk

The file is parsed from the request in memory, under the size cap. No upload
directory exists, so there is nothing to leak, scan, or forget to clean up —
and no path for a customer CSV to be committed by accident.

## Consequences

### Positive

- The operator sees what will happen before it happens.
- Partial failure is survivable and reported precisely.
- Imported data never claims provenance it does not have.
- No customer file ever touches the filesystem.

### Negative

- The 10,000-row cap means very large migrations need splitting. A deliberate
  first limit; raising it needs a background job, not a bigger number.
- Whole-file validation holds the parsed rows in memory. Bounded by the caps.
- Partial imports must be explained clearly in the UI.

## Revisit when

- A customer needs >10,000 rows → move to `apps/worker` with progress.
- Import of companies, opportunities or tasks is requested.

## Related

- [ADR-0021](ADR-0021-ingestion-and-idempotency.md) · [ADR-0012](ADR-0012-provenance-model.md)
