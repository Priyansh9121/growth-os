/**
 * Web property administration.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The workspace's websites — shared with the Stage 4 crawler and Search
 * Console later, which is why the model is deliberately plain and carries no
 * forms-specific concepts (ADR-0029).
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ConflictError,
  ValidationError,
  type CreateSiteInput,
  type SiteView,
} from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import {
  actorUserIdOrNull,
  contextNow,
  inTenant,
  requireCapability,
  tenantScope,
  type SitesContext,
} from './context';
import { normaliseOrigin } from './origin';

const { forms, sites } = schemaTables;

export async function listSites(context: SitesContext): Promise<readonly SiteView[]> {
  requireCapability(context, 'workspace:sites:read');

  return inTenant(context, async (tx, workspace) => {
    const rows = await tx
      .select({
        id: sites.id,
        name: sites.name,
        origin: sites.origin,
        status: sites.status,
        verificationState: sites.verificationState,
        createdAt: sites.createdAt,
        formCount: sql<number>`(
          select count(*)::int from ${forms} where ${forms.siteId} = ${sites.id})`,
      })
      .from(sites)
      .where(tenantScope(sites, workspace))
      .orderBy(desc(sites.createdAt));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      origin: row.origin,
      status: row.status,
      verificationState: row.verificationState,
      formCount: row.formCount,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

export async function createSite(context: SitesContext, input: CreateSiteInput): Promise<SiteView> {
  requireCapability(context, 'workspace:sites:manage');

  // Normalised BEFORE the uniqueness check, or `abcplumbing.test` and
  // `https://abcplumbing.test/` would be two rows for one website.
  const origin = normaliseOrigin(input.origin);
  if (origin === null) {
    throw new ValidationError('Enter a website address like https://www.example.com.');
  }

  return inTenant(context, async (tx, workspace) => {
    const [existing] = await tx
      .select({ id: sites.id })
      .from(sites)
      .where(and(tenantScope(sites, workspace), eq(sites.origin, origin)))
      .limit(1);

    if (existing) {
      throw new ConflictError(
        `Site ${origin} already exists in workspace ${workspace}`,
        'That website is already registered.',
      );
    }

    const now = contextNow(context);
    const [row] = await tx
      .insert(sites)
      .values({
        workspaceId: workspace,
        name: input.name,
        origin,
        createdByUserId: actorUserIdOrNull(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) throw new Error('Failed to create site');

    return {
      id: row.id,
      name: row.name,
      origin: row.origin,
      status: row.status,
      // Always `unverified` in Stage 3. Verification is a Stage 4 flow, and
      // the UI labels it rather than leaving it blank — a silent field would
      // read as "verified" to anyone who did not check (ADR-0029 §3).
      verificationState: row.verificationState,
      formCount: 0,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
