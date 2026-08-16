/**
 * The submissions list — an INGESTION view, not a second CRM.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Answering "did that enquiry arrive, and what happened to it?". It shows the
 * outcome, the classified source, and a LINK to the contact — never a copy of
 * the contact, because the CRM already owns that and a second rendering would
 * drift from it.
 *
 * The contact NAME is joined at read time rather than stored on the receipt.
 * That matters: after an erasure, this list shows "Erased contact" because it
 * reads the live row, instead of preserving a name erasure was supposed to
 * remove.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { RejectionReason, SubmissionReceiptView } from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import { inTenant, requireCapability, tenantScope, type FormsContext } from '../shared/context';

const { contacts, formSubmissions, formVersions } = schemaTables;

export async function listSubmissions(
  context: FormsContext,
  formId: string,
  limit = 50,
): Promise<readonly SubmissionReceiptView[]> {
  requireCapability(context, 'workspace:forms:read');

  return inTenant(context, async (tx, workspace) => {
    const rows = await tx
      .select({
        id: formSubmissions.id,
        outcome: formSubmissions.outcome,
        rejectionReason: formSubmissions.rejectionReason,
        contactId: formSubmissions.contactId,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        matchedExisting: formSubmissions.matchedExisting,
        opportunityId: formSubmissions.opportunityId,
        sourceType: formSubmissions.sourceType,
        version: formVersions.version,
        createdAt: formSubmissions.createdAt,
      })
      .from(formSubmissions)
      // LEFT joins throughout: a rejected submission has no contact, and an
      // erased one may have lost its version. Neither should hide the receipt.
      .leftJoin(contacts, eq(contacts.id, formSubmissions.contactId))
      .leftJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
      .where(and(tenantScope(formSubmissions, workspace), eq(formSubmissions.formId, formId)))
      .orderBy(desc(formSubmissions.createdAt))
      .limit(Math.min(limit, 200));

    return rows.map((row) => ({
      id: row.id,
      outcome: row.outcome,
      rejectionReason: (row.rejectionReason as RejectionReason | null) ?? null,
      contactId: row.contactId,
      contactName: row.firstName ? [row.firstName, row.lastName].filter(Boolean).join(' ') : null,
      matchedExisting: row.matchedExisting,
      opportunityId: row.opportunityId,
      sourceType: row.sourceType,
      formVersion: row.version,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/** Submission counts for the dashboard. Live CRM data, never a fixture. */
export async function countRecentLeads(
  context: FormsContext,
  sinceDays = 30,
): Promise<{ captured: number; rejected: number }> {
  requireCapability(context, 'workspace:forms:read');

  return inTenant(context, async (tx, workspace) => {
    const [row] = await tx
      .select({
        captured: sql<number>`count(*) filter (where ${formSubmissions.outcome} = 'created')::int`,
        rejected: sql<number>`count(*) filter (where ${formSubmissions.outcome} = 'rejected')::int`,
      })
      .from(formSubmissions)
      .where(
        and(
          tenantScope(formSubmissions, workspace),
          sql`${formSubmissions.createdAt} > now() - make_interval(days => ${sinceDays})`,
        ),
      );

    return { captured: row?.captured ?? 0, rejected: row?.rejected ?? 0 };
  });
}
