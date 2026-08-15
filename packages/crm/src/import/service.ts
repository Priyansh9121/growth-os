/**
 * Bulk CSV import.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The first bulk write path into the CRM, and the first exercise of the
 * ingestion boundary at volume. It is also where a customer's existing, messy,
 * real data arrives — with duplicates, bad encodings and columns nobody
 * expects.
 *
 * VALIDATE EVERYTHING, THEN WRITE IN CHUNKS
 * One malformed row must not discard 9,999 good ones, and a single transaction
 * over 10,000 rows holds locks far too long. So every row is validated up
 * front with no mutation, then valid rows are written in transactional chunks.
 * A chunk that fails rolls back only itself.
 *
 * The honest consequence: A PARTIALLY-SUCCESSFUL IMPORT IS POSSIBLE, and the
 * result reports exactly which rows landed. That beats an all-or-nothing
 * import of a 10,000-row file that fails at row 9,998, and it beats a
 * per-row transaction that is ten thousand round trips (ADR-0023 §2).
 *
 * PROVENANCE IS `import`, AND SAYS SO
 * If the file has a "Source" column, its value is recorded as `channelDetail`
 * and is NEVER promoted to `sourceType`. A spreadsheet saying "Google" is a
 * human's recollection, not a measurement, and treating it as declared
 * provenance would poison attribution with exactly the fabrication ADR-0012
 * exists to prevent.
 *
 * @see docs/decisions/ADR-0023-csv-import.md
 */

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  IMPORT_CHUNK_SIZE,
  IMPORT_SOURCE_TYPE,
  ingestAcquisitionSchema,
  type ImportBatchView,
  type ImportFieldTarget,
  type ImportMappingInput,
  type ImportResult,
  type ImportRowIssue,
  type ImportValidation,
  type IngestAcquisitionParsed,
} from '@growth-os/contracts';
import {
  AUDIT_EVENTS,
  schemaTables,
  withTenantTransaction,
  writeAuditEvent,
} from '@growth-os/database';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import {
  actorUserId,
  contextNow,
  inTenant,
  requireCapability,
  tenantScope,
  workspaceId,
  type CrmContext,
} from '../shared/context';
import { ingestInTransaction } from '../ingestion/service';

const { contacts, importBatches, workspaces } = schemaTables;

/** Source system recorded on every receipt an import writes. */
const IMPORT_SOURCE_SYSTEM = 'import';

interface PreparedRow {
  /** 1-based, excluding the header — what a spreadsheet shows. */
  readonly rowNumber: number;
  readonly input: IngestAcquisitionParsed;
  readonly emailNormalised: string | null;
  readonly phoneE164: string | null;
}

/**
 * Check a mapped file. **Mutates nothing.**
 *
 * The operator sees counts of valid, invalid and probable-duplicate rows
 * before anything is written. An import that silently created 4,000 contacts
 * on file selection is not recoverable by any means this product offers.
 */
export async function validateImport(
  context: CrmContext,
  input: ImportMappingInput,
): Promise<ImportValidation> {
  requireCapability(context, 'workspace:crm:contacts:import');

  return inTenant(context, async (tx, workspace) => {
    const region = await phoneRegion(tx, workspace);
    const { prepared, issues } = prepareRows(input, region);

    return {
      totalRows: input.rows.length,
      validRows: prepared.length,
      issues,
      matchesExisting: await countExistingMatches(tx, workspace, prepared),
    };
  });
}

export async function runImport(
  context: CrmContext,
  input: ImportMappingInput,
): Promise<ImportResult> {
  requireCapability(context, 'workspace:crm:contacts:import');

  const now = contextNow(context);
  const workspace = workspaceId(context);

  const region = await inTenant(context, (tx, ws) => phoneRegion(tx, ws));
  const { prepared, issues } = prepareRows(input, region);

  // The batch row is created in its own transaction, BEFORE any chunk runs, so
  // a run that dies partway still leaves a record an operator can find. A
  // batch created alongside the first chunk would vanish with it.
  const batchId = await inTenant(context, async (tx, ws) => {
    const [row] = await tx
      .insert(importBatches)
      .values({
        workspaceId: ws,
        filename: input.filename,
        status: 'importing',
        totalRows: input.rows.length,
        validRows: prepared.length,
        invalidRows: issues.length,
        // Column NAMES only. A mapping records which heading feeds which
        // field; row values never appear here.
        columnMapping: input.mapping,
        startedByUserId: actorUserId(context),
        startedAt: now,
      })
      .returning({ id: importBatches.id });

    if (!row) throw new Error('Failed to create import batch');
    return row.id;
  });

  let imported = 0;
  let matchedExisting = 0;
  const failures: ImportRowIssue[] = [];

  for (let offset = 0; offset < prepared.length; offset += IMPORT_CHUNK_SIZE) {
    const chunk = prepared.slice(offset, offset + IMPORT_CHUNK_SIZE);

    try {
      const outcomes = await withTenantTransaction(context.deps.db, workspace, async (tx) => {
        const results = [];
        for (const row of chunk) {
          results.push(
            await ingestInTransaction(
              context,
              tx,
              workspace,
              withImportIdentity(row.input, batchId, row.rowNumber),
              now,
            ),
          );
        }
        return results;
      });

      for (const outcome of outcomes) {
        imported += 1;
        if (outcome.match === 'matched_existing') matchedExisting += 1;
      }
    } catch (error) {
      // One chunk failing must not abandon the rest. Every row in it is
      // reported by number so the operator can find them in their own file
      // rather than being told "some rows failed".
      const reason = error instanceof Error ? error.message : 'Unknown error';
      for (const row of chunk) {
        failures.push({ row: row.rowNumber, message: reason });
      }
    }
  }

  const status = failures.length === 0 ? 'completed' : imported > 0 ? 'partial' : 'failed';

  await inTenant(context, async (tx, ws) => {
    await tx
      .update(importBatches)
      .set({
        status,
        importedRows: imported,
        matchedExistingRows: matchedExisting,
        failedRows: failures.length,
        completedAt: new Date(),
      })
      .where(and(eq(importBatches.id, batchId), tenantScope(importBatches, ws)));

    await writeAuditEvent(
      context.deps.db,
      {
        workspaceId: ws,
        actorUserId: actorUserId(context),
        eventName: AUDIT_EVENTS.CRM_CONTACTS_IMPORTED,
        accessPath: context.tenant.workspace.via,
        targetType: 'import_batch',
        targetId: batchId,
        correlationId: context.correlationId ?? undefined,
        // Counts and the filename. Never a row, a name or an address — the
        // audit trail must not become a partial copy of the imported file.
        metadata: {
          filename: input.filename,
          status,
          imported,
          matchedExisting,
          failed: failures.length,
        },
      },
      tx,
    );
  });

  context.deps.events.publish({
    name: 'crm.contacts.imported',
    workspaceId: workspace,
    occurredAt: now.toISOString(),
    correlationId: context.correlationId,
    actorType: 'user',
    actorUserId: actorUserId(context),
    batchId,
    importedRows: imported,
    matchedExistingRows: matchedExisting,
    failedRows: failures.length,
  });

  return {
    batchId,
    status,
    totalRows: input.rows.length,
    importedRows: imported,
    matchedExistingRows: matchedExisting,
    failedRows: failures.length,
    // Validation issues first — they are the ones the operator can fix by
    // editing their file and re-running.
    issues: [...issues, ...failures].slice(0, 200),
  };
}

export async function listImportBatches(
  context: CrmContext,
  limit = 20,
): Promise<readonly ImportBatchView[]> {
  requireCapability(context, 'workspace:crm:contacts:import');

  return inTenant(context, async (tx, workspace) => {
    const rows = await tx
      .select()
      .from(importBatches)
      .where(tenantScope(importBatches, workspace))
      .orderBy(sql`${importBatches.startedAt} desc`)
      .limit(Math.min(limit, 100));

    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      status: row.status,
      totalRows: row.totalRows,
      importedRows: row.importedRows,
      matchedExistingRows: row.matchedExistingRows,
      failedRows: row.failedRows,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    }));
  });
}

// ---------------------------------------------------------------------------
// Row preparation
// ---------------------------------------------------------------------------

/**
 * Turn mapped CSV rows into validated ingestion inputs.
 *
 * Pure and synchronous, so it is unit-testable without a database — which
 * matters because this function decides what a customer's data becomes.
 */
export function prepareRows(
  input: ImportMappingInput,
  region: string,
): { prepared: PreparedRow[]; issues: ImportRowIssue[] } {
  const prepared: PreparedRow[] = [];
  const issues: ImportRowIssue[] = [];

  // Reverse the mapping once rather than scanning it per row.
  const targets = new Map<ImportFieldTarget, string>();
  for (const [header, target] of Object.entries(input.mapping)) {
    if (target === 'ignore') continue;
    // First mapping wins. Two headers aimed at the same field is an operator
    // mistake, and picking the last one silently would make the outcome depend
    // on object key order.
    if (!targets.has(target)) targets.set(target, header);
  }

  input.rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const read = (target: ImportFieldTarget): string | undefined => {
      const header = targets.get(target);
      if (header === undefined) return undefined;
      const value = row[header]?.trim();
      return value === undefined || value.length === 0 ? undefined : value;
    };

    const candidate = {
      identity: {
        firstName: read('firstName'),
        lastName: read('lastName'),
        email: read('email'),
        phone: read('phone'),
        companyName: read('companyName'),
      },
      provenance: {
        // NEVER read from the file. An imported row's provenance is that it
        // was imported — that is the only thing we actually observed.
        sourceType: IMPORT_SOURCE_TYPE,
        sourcePlatform: 'unknown' as const,
        confidence: 'manual' as const,
        // A "Source" column lands here, as a human note, and nowhere else.
        channelDetail: read('sourceDetail'),
      },
      matchPolicy: 'match_then_create' as const,
    };

    const parsed = ingestAcquisitionSchema.safeParse(candidate);
    if (!parsed.success) {
      issues.push({
        row: rowNumber,
        // Field names and rule messages only. Echoing the offending VALUE back
        // would put customer data into an API response and, from there, into
        // whatever logs it.
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`)
          .join('; '),
      });
      return;
    }

    prepared.push({
      rowNumber,
      input: parsed.data,
      emailNormalised: normaliseEmail(parsed.data.identity.email),
      phoneE164: normalisePhone(parsed.data.identity.phone, region),
    });
  });

  return { prepared, issues };
}

/**
 * Attach the per-row idempotency key.
 *
 * `import:<batch>:<row>` makes a resumed or retried batch safe. Re-uploading
 * the SAME FILE as a new batch deliberately produces a new key set — the
 * operator may genuinely intend to re-import after fixing data. What protects
 * them then is that ingestion still matches on normalised email and phone, so
 * a re-import updates nothing and creates acquisitions against the existing
 * people rather than duplicate contacts (ADR-0023 §4).
 */
function withImportIdentity(
  input: IngestAcquisitionParsed,
  batchId: string,
  rowNumber: number,
): IngestAcquisitionParsed {
  return {
    ...input,
    idempotency: {
      sourceSystem: IMPORT_SOURCE_SYSTEM,
      externalKey: `import:${batchId}:${rowNumber}`,
    },
  };
}

/**
 * How many prepared rows already match a live contact.
 *
 * Shown in the review step so the operator knows before committing that, say,
 * 40 of their 300 rows are people already in the CRM. Not an error — ingestion
 * will attach the acquisition to the existing person — but a surprise if it
 * only appears afterwards.
 */
async function countExistingMatches(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  prepared: readonly PreparedRow[],
): Promise<number> {
  const emails = [...new Set(prepared.map((row) => row.emailNormalised).filter(isPresent))];
  const phones = [...new Set(prepared.map((row) => row.phoneE164).filter(isPresent))];
  if (emails.length === 0 && phones.length === 0) return 0;

  const identity: SQL[] = [];
  // `inArray`, not `sql`col = any(${jsArray})``: postgres.js binds a JS array
  // inside a template as a single scalar, and PostgreSQL rejects it as a
  // malformed array literal. Drizzle's helper expands it properly.
  if (emails.length > 0) identity.push(inArray(contacts.emailNormalised, emails));
  if (phones.length > 0) identity.push(inArray(contacts.phoneE164, phones));

  const matcher = identity.length === 1 ? identity[0] : or(...identity);
  if (!matcher) return 0;

  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(contacts)
    .where(
      and(
        tenantScope(contacts, workspace),
        isNull(contacts.deletedAt),
        isNull(contacts.mergedAt),
        isNull(contacts.erasedAt),
        matcher,
      ),
    );

  return row?.total ?? 0;
}

function isPresent(value: string | null): value is string {
  return value !== null;
}

async function phoneRegion(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
): Promise<string> {
  const [row] = await tx
    .select({ region: workspaces.defaultPhoneRegion })
    .from(workspaces)
    .where(eq(workspaces.id, workspace))
    .limit(1);
  return row?.region ?? 'AU';
}
