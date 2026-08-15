/**
 * Contact application service.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Owns the contact lifecycle and, critically, the atomic creation of a contact
 * together with its first acquisition. A contact whose provenance failed to
 * save is exactly the data loss the three-entity model exists to prevent, so
 * both are written in one transaction or neither is.
 *
 * DEDUPLICATION REPORTS; IT NEVER MERGES
 * `createContact` returns a `duplicateOf` candidate when an existing contact
 * shares a normalised email or phone. It does not merge, because merging two
 * real people is destructive and effectively irreversible — and shared
 * mailboxes (`office@`, `info@`) are extremely common in the target segment.
 *
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 * @see docs/decisions/ADR-0015-contact-identity-and-deduplication.md
 */

import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  assertProvenanceIntegrity,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ContactFilters,
  type ContactView,
  type CreateContactInput,
  type CreateContactResult,
  type Page,
  type UpdateContactInput,
} from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import { displayName, normaliseEmail, normalisePhone } from '../identity/normalise';
import { decodeCursor, sliceToPage } from '../shared/pagination';
import {
  actorUserId,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type CrmContext,
} from '../shared/context';
import { recordActivity } from '../activities/service';
import { insertAcquisition } from '../acquisitions/service';

const { acquisitions, companies, contacts, opportunities, users, workspaces } = schemaTables;

/** Re-exported from contracts, where the API shape is defined (ADR-0011 §7). */
export type { CreateContactResult };

/** Read the workspace's phone region once per operation that needs it. */
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

export async function createContact(
  context: CrmContext,
  input: CreateContactInput,
): Promise<CreateContactResult> {
  requireCapability(context, 'workspace:crm:contacts:write');

  // Provenance integrity is checked BEFORE the transaction opens: a fabricated
  // search query must fail loudly, not roll back halfway through.
  if (input.acquisition) {
    try {
      assertProvenanceIntegrity(input.acquisition);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'Invalid provenance.');
    }
  }

  return inTenant(context, async (tx, workspace) => {
    const region = await phoneRegion(tx, workspace);
    const emailNormalised = normaliseEmail(input.email);
    const phoneE164 = normalisePhone(input.phone, region);

    // Candidate check, scoped to live rows in this workspace only.
    const duplicate = await findDuplicateCandidate(tx, workspace, emailNormalised, phoneE164);

    if (input.companyId) {
      // Verify the company is ours before linking. Without this, a caller
      // could attach a contact to another tenant's company id.
      await loadInTenant(tx, companies, workspace, input.companyId);
    }

    const now = contextNow(context);
    const [row] = await tx
      .insert(contacts)
      .values({
        workspaceId: workspace,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        email: input.email ?? null,
        emailNormalised,
        phone: input.phone ?? null,
        phoneE164,
        companyId: input.companyId ?? null,
        ownerUserId: input.ownerUserId ?? actorUserId(context),
        createdByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) throw new Error('Failed to insert contact');

    await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.CONTACT_CREATED,
      summary: `${displayName(row.firstName, row.lastName)} added`,
      contactId: row.id,
      occurredAt: now,
    });

    // Same transaction: a contact without the provenance that came with it is
    // the failure mode this whole model exists to avoid.
    if (input.acquisition) {
      await insertAcquisition(context, tx, {
        contactId: row.id,
        provenance: input.acquisition,
        capturedAt: now,
      });
    }

    context.deps.events.publish({
      name: 'crm.contact.created',
      workspaceId: workspace,
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      actorType: 'user',
      actorUserId: actorUserId(context),
      contactId: row.id,
      // Identifiers and booleans only — an event never carries PII (ADR-0011).
      hasEmail: emailNormalised !== null,
      hasPhone: phoneE164 !== null,
    });

    return {
      contact: await projectContact(tx, workspace, row.id),
      duplicateOf: duplicate,
    };
  });
}

async function findDuplicateCandidate(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  emailNormalised: string | null,
  phoneE164: string | null,
): Promise<CreateContactResult['duplicateOf']> {
  if (emailNormalised === null && phoneE164 === null) return null;

  const identityMatches: SQL[] = [];
  if (emailNormalised) identityMatches.push(eq(contacts.emailNormalised, emailNormalised));
  if (phoneE164) identityMatches.push(eq(contacts.phoneE164, phoneE164));

  const matcher = identityMatches.length === 1 ? identityMatches[0] : or(...identityMatches);
  if (!matcher) return null;

  const [existing] = await tx
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      emailNormalised: contacts.emailNormalised,
    })
    .from(contacts)
    .where(and(tenantScope(contacts, workspace), isNull(contacts.deletedAt), matcher))
    .limit(1);

  if (!existing) return null;

  return {
    id: existing.id,
    displayName: displayName(existing.firstName, existing.lastName),
    // Names are NEVER used for matching — two "James Carter"s are two people.
    matchedOn: emailNormalised && existing.emailNormalised === emailNormalised ? 'email' : 'phone',
  };
}

export async function getContact(context: CrmContext, contactId: string): Promise<ContactView> {
  requireCapability(context, 'workspace:crm:contacts:read');

  return inTenant(context, async (tx, workspace) => {
    // Tenant-scoped load: another workspace's contact is never fetched, so
    // there is no row to accidentally leak by checking ownership too late.
    await loadInTenant(tx, contacts, workspace, contactId, [isNull(contacts.deletedAt)]);
    return projectContact(tx, workspace, contactId);
  });
}

export async function updateContact(
  context: CrmContext,
  contactId: string,
  input: UpdateContactInput,
): Promise<ContactView> {
  requireCapability(context, 'workspace:crm:contacts:write');

  return inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, contacts, workspace, contactId, [
      isNull(contacts.deletedAt),
    ]);
    const region = await phoneRegion(tx, workspace);
    const now = contextNow(context);

    if (input.companyId) {
      await loadInTenant(tx, companies, workspace, input.companyId);
    }

    const changes: Record<string, unknown> = { updatedAt: now };
    if (input.firstName !== undefined) changes['firstName'] = input.firstName;
    if (input.lastName !== undefined) changes['lastName'] = input.lastName ?? null;
    if (input.email !== undefined) {
      changes['email'] = input.email ?? null;
      changes['emailNormalised'] = normaliseEmail(input.email);
    }
    if (input.phone !== undefined) {
      changes['phone'] = input.phone ?? null;
      changes['phoneE164'] = normalisePhone(input.phone, region);
    }
    if (input.companyId !== undefined) changes['companyId'] = input.companyId;
    if (input.ownerUserId !== undefined) changes['ownerUserId'] = input.ownerUserId;

    await tx
      .update(contacts)
      .set(changes)
      .where(and(eq(contacts.id, contactId), tenantScope(contacts, workspace)));

    await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.CONTACT_UPDATED,
      summary: `${displayName(existing.firstName, existing.lastName)} updated`,
      contactId,
      occurredAt: now,
      // Field NAMES only — never the old and new values, which are PII and
      // would put customer data into a fan-out surface.
      metadata: { fields: Object.keys(changes).filter((key) => key !== 'updatedAt') },
    });

    return projectContact(tx, workspace, contactId);
  });
}

/**
 * Archive a contact (soft delete).
 *
 * Requires `contacts:archive`, which `member` does not hold — removing a
 * customer record is an administrative act, not a daily one.
 */
export async function archiveContact(context: CrmContext, contactId: string): Promise<void> {
  requireCapability(context, 'workspace:crm:contacts:archive');

  await inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, contacts, workspace, contactId, [
      isNull(contacts.deletedAt),
    ]);

    // An archived contact whose deals are still on the board would be a
    // dangling reference in the UI. Refuse, rather than silently orphaning.
    const [openDeal] = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(
        and(
          tenantScope(opportunities, workspace),
          eq(opportunities.contactId, contactId),
          eq(opportunities.status, 'open'),
        ),
      )
      .limit(1);

    if (openDeal) {
      throw new ConflictError(
        `Contact ${contactId} has open opportunities`,
        'Close or move this contact’s open opportunities before archiving them.',
      );
    }

    const now = contextNow(context);
    await tx
      .update(contacts)
      .set({ deletedAt: now, deletedByUserId: actorUserId(context), updatedAt: now })
      .where(and(eq(contacts.id, contactId), tenantScope(contacts, workspace)));

    await recordActivity(context, tx, {
      type: ACTIVITY_TYPES.CONTACT_ARCHIVED,
      summary: `${displayName(existing.firstName, existing.lastName)} archived`,
      contactId,
      occurredAt: now,
    });
  });
}

export async function listContacts(
  context: CrmContext,
  filters: ContactFilters,
): Promise<Page<ContactView>> {
  requireCapability(context, 'workspace:crm:contacts:read');

  const cursor = decodeCursor(filters.cursor);

  return inTenant(context, async (tx, workspace) => {
    const conditions: SQL[] = [tenantScope(contacts, workspace), isNull(contacts.deletedAt)];

    if (filters.ownerUserId) conditions.push(eq(contacts.ownerUserId, filters.ownerUserId));
    if (filters.companyId) conditions.push(eq(contacts.companyId, filters.companyId));

    if (filters.query) {
      // Substring match on name and the normalised identity columns. Full-text
      // search is the wrong tool for short identifiers — someone typing "sar"
      // or the last four digits of a phone number (ADR-0016 §3).
      const term = `%${filters.query.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      const search = or(
        ilike(contacts.firstName, term),
        ilike(contacts.lastName, term),
        ilike(contacts.emailNormalised, term),
        ilike(contacts.phoneE164, term),
      );
      if (search) conditions.push(search);
    }

    if (filters.sourceType) {
      // Filter by FIRST-touch source: the acquisition that actually introduced
      // this person, not the most recent one.
      conditions.push(
        sql`exists (
          select 1 from ${acquisitions} a
          where a.contact_id = ${contacts.id}
            and a.source_type = ${filters.sourceType}
            and a.captured_at = (
              select min(a2.captured_at) from ${acquisitions} a2 where a2.contact_id = ${contacts.id}
            )
        )`,
      );
    }

    const sortColumn =
      filters.sort === 'lastName'
        ? contacts.lastName
        : filters.sort === 'updatedAt'
          ? contacts.updatedAt
          : contacts.createdAt;

    if (cursor) {
      const value = filters.sort === 'lastName' ? cursor.value : new Date(cursor.value);
      const keyset =
        filters.direction === 'asc'
          ? or(gt(sortColumn, value), and(eq(sortColumn, value), gt(contacts.id, cursor.id)))
          : or(lt(sortColumn, value), and(eq(sortColumn, value), lt(contacts.id, cursor.id)));
      if (keyset) conditions.push(keyset);
    }

    const order = filters.direction === 'asc' ? asc : desc;

    const rows = await tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        companyId: contacts.companyId,
        companyName: companies.name,
        ownerUserId: contacts.ownerUserId,
        ownerName: users.name,
        createdAt: contacts.createdAt,
        updatedAt: contacts.updatedAt,
        deletedAt: contacts.deletedAt,
        sortValue: sortColumn,
      })
      .from(contacts)
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .leftJoin(users, eq(users.id, contacts.ownerUserId))
      .where(and(...conditions))
      .orderBy(order(sortColumn), order(contacts.id))
      .limit(filters.limit + 1);

    const page = sliceToPage(rows, filters.limit, (row) =>
      row.sortValue instanceof Date ? row.sortValue.toISOString() : String(row.sortValue ?? ''),
    );

    // One batched query for first-touch source and open deal counts, rather
    // than N+1 per row.
    const ids = page.items.map((row) => row.id);
    const [sources, dealCounts, lastActivity] = await Promise.all([
      firstTouchSources(tx, ids),
      openOpportunityCounts(tx, ids),
      lastActivityAt(tx, ids),
    ]);

    return {
      items: page.items.map((row): ContactView => ({
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        displayName: displayName(row.firstName, row.lastName),
        email: row.email,
        phone: row.phone,
        phoneE164: row.phoneE164,
        companyId: row.companyId,
        companyName: row.companyName,
        ownerUserId: row.ownerUserId,
        ownerName: row.ownerName,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        archivedAt: row.deletedAt?.toISOString() ?? null,
        firstSource: sources.get(row.id) ?? null,
        openOpportunityCount: dealCounts.get(row.id) ?? 0,
        lastActivityAt: lastActivity.get(row.id) ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  });
}

/** First-touch provenance for a batch of contacts. `DISTINCT ON` beats N+1. */
async function firstTouchSources(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  contactIds: readonly string[],
): Promise<Map<string, ContactView['firstSource']>> {
  const result = new Map<string, ContactView['firstSource']>();
  if (contactIds.length === 0) return result;

  const rows = await tx
    .selectDistinctOn([acquisitions.contactId], {
      contactId: acquisitions.contactId,
      sourceType: acquisitions.sourceType,
      sourcePlatform: acquisitions.sourcePlatform,
      confidence: acquisitions.confidence,
      landingPath: acquisitions.landingPath,
      capturedAt: acquisitions.capturedAt,
    })
    .from(acquisitions)
    .where(inArray(acquisitions.contactId, [...contactIds]))
    .orderBy(acquisitions.contactId, asc(acquisitions.capturedAt));

  for (const row of rows) {
    result.set(row.contactId, {
      sourceType: row.sourceType,
      sourcePlatform: row.sourcePlatform,
      confidence: row.confidence,
      landingPath: row.landingPath,
      capturedAt: row.capturedAt.toISOString(),
    });
  }
  return result;
}

async function openOpportunityCounts(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  contactIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (contactIds.length === 0) return result;

  const rows = await tx
    .select({ contactId: opportunities.contactId, count: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(and(inArray(opportunities.contactId, [...contactIds]), eq(opportunities.status, 'open')))
    .groupBy(opportunities.contactId);

  for (const row of rows) result.set(row.contactId, row.count);
  return result;
}

async function lastActivityAt(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  contactIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (contactIds.length === 0) return result;

  const { activities } = schemaTables;
  const rows = await tx
    .select({ contactId: activities.contactId, latest: sql<Date>`max(${activities.occurredAt})` })
    .from(activities)
    .where(inArray(activities.contactId, [...contactIds]))
    .groupBy(activities.contactId);

  for (const row of rows) {
    if (row.contactId && row.latest) result.set(row.contactId, new Date(row.latest).toISOString());
  }
  return result;
}

/** Build the full view for a single contact. */
async function projectContact(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  contactId: string,
): Promise<ContactView> {
  const [row] = await tx
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      companyId: contacts.companyId,
      companyName: companies.name,
      ownerUserId: contacts.ownerUserId,
      ownerName: users.name,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(users, eq(users.id, contacts.ownerUserId))
    .where(and(eq(contacts.id, contactId), tenantScope(contacts, workspace)))
    .limit(1);

  if (!row) throw new NotFoundError(`Contact ${contactId} not found`);

  const [sources, counts, activity] = await Promise.all([
    firstTouchSources(tx, [contactId]),
    openOpportunityCounts(tx, [contactId]),
    lastActivityAt(tx, [contactId]),
  ]);

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: displayName(row.firstName, row.lastName),
    email: row.email,
    phone: row.phone,
    phoneE164: row.phoneE164,
    companyId: row.companyId,
    companyName: row.companyName,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.deletedAt?.toISOString() ?? null,
    firstSource: sources.get(contactId) ?? null,
    openOpportunityCount: counts.get(contactId) ?? 0,
    lastActivityAt: activity.get(contactId) ?? null,
  };
}

export { projectContact };
