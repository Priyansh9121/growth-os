/**
 * Company service.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Organisations that contacts may belong to. Intentionally thin at Stage 2 —
 * companies exist so a contact can be attributed to a business and so B2B
 * pipelines make sense, not as a full account-management surface.
 *
 * Soft-deleted like contacts: identity records are recoverable (ADR-0013).
 */

import { and, asc, desc, eq, ilike, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type {
  CompanyView,
  CreateCompanyInput,
  Page,
  UpdateCompanyInput,
} from '@growth-os/contracts';
import { NotFoundError } from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import { normalisePhone, normaliseWebsiteHost } from '../identity/normalise';
import { containsPattern } from '../shared/like';
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

const { companies, contacts, workspaces } = schemaTables;

export async function createCompany(
  context: CrmContext,
  input: CreateCompanyInput,
): Promise<CompanyView> {
  requireCapability(context, 'workspace:crm:companies:write');

  return inTenant(context, async (tx, workspace) => {
    const [ws] = await tx
      .select({ region: workspaces.defaultPhoneRegion })
      .from(workspaces)
      .where(eq(workspaces.id, workspace))
      .limit(1);

    const now = contextNow(context);
    const [row] = await tx
      .insert(companies)
      .values({
        workspaceId: workspace,
        name: input.name,
        websiteHost: normaliseWebsiteHost(input.website),
        phone: input.phone ?? null,
        phoneE164: normalisePhone(input.phone, ws?.region ?? 'AU'),
        ownerUserId: input.ownerUserId ?? actorUserId(context),
        createdByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: companies.id });

    if (!row) throw new Error('Failed to insert company');
    return projectCompany(tx, workspace, row.id);
  });
}

export async function updateCompany(
  context: CrmContext,
  companyId: string,
  input: UpdateCompanyInput,
): Promise<CompanyView> {
  requireCapability(context, 'workspace:crm:companies:write');

  return inTenant(context, async (tx, workspace) => {
    await loadInTenant(tx, companies, workspace, companyId, [isNull(companies.deletedAt)]);

    const changes: Record<string, unknown> = { updatedAt: contextNow(context) };
    if (input.name !== undefined) changes['name'] = input.name;
    if (input.website !== undefined) changes['websiteHost'] = normaliseWebsiteHost(input.website);
    if (input.ownerUserId !== undefined) changes['ownerUserId'] = input.ownerUserId;

    await tx
      .update(companies)
      .set(changes)
      .where(and(eq(companies.id, companyId), tenantScope(companies, workspace)));

    return projectCompany(tx, workspace, companyId);
  });
}

export async function listCompanies(
  context: CrmContext,
  filters: { query?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<Page<CompanyView>> {
  requireCapability(context, 'workspace:crm:companies:read');

  const cursor = decodeCursor(filters.cursor);

  return inTenant(context, async (tx, workspace) => {
    const conditions: SQL[] = [tenantScope(companies, workspace), isNull(companies.deletedAt)];

    if (filters.query) {
      const term = containsPattern(filters.query);
      conditions.push(ilike(companies.name, term));
    }

    if (cursor) {
      const value = new Date(cursor.value);
      const keyset = or(
        lt(companies.createdAt, value),
        and(eq(companies.createdAt, value), lt(companies.id, cursor.id)),
      );
      if (keyset) conditions.push(keyset);
    }

    const rows = await tx
      .select({
        id: companies.id,
        name: companies.name,
        websiteHost: companies.websiteHost,
        phone: companies.phone,
        ownerUserId: companies.ownerUserId,
        createdAt: companies.createdAt,
        deletedAt: companies.deletedAt,
        contactCount: sql<number>`(
          select count(*)::int from ${contacts} c
          where c.company_id = ${companies.id} and c.deleted_at is null
        )`,
      })
      .from(companies)
      .where(and(...conditions))
      .orderBy(desc(companies.createdAt), desc(companies.id))
      .limit(filters.limit + 1);

    const page = sliceToPage(rows, filters.limit, (row) => row.createdAt.toISOString());

    return {
      items: page.items.map((row): CompanyView => ({
        id: row.id,
        name: row.name,
        website: row.websiteHost,
        phone: row.phone,
        ownerUserId: row.ownerUserId,
        contactCount: row.contactCount,
        createdAt: row.createdAt.toISOString(),
        archivedAt: row.deletedAt?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  });
}

async function projectCompany(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  companyId: string,
): Promise<CompanyView> {
  const [row] = await tx
    .select({
      id: companies.id,
      name: companies.name,
      websiteHost: companies.websiteHost,
      phone: companies.phone,
      ownerUserId: companies.ownerUserId,
      createdAt: companies.createdAt,
      deletedAt: companies.deletedAt,
      contactCount: sql<number>`(
        select count(*)::int from ${contacts} c
        where c.company_id = ${companies.id} and c.deleted_at is null
      )`,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), tenantScope(companies, workspace)))
    .limit(1);

  if (!row) throw new NotFoundError(`Company ${companyId} not found`);

  return {
    id: row.id,
    name: row.name,
    website: row.websiteHost,
    phone: row.phone,
    ownerUserId: row.ownerUserId,
    contactCount: row.contactCount,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export { asc };
