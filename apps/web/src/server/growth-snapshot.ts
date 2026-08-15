import 'server-only';

/**
 * Dashboard snapshot assembly.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Builds the dashboard's `GrowthSnapshot` from a MIX of real, database-derived
 * CRM values and remaining Stage 1 fixtures — and labels each one correctly.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE (Principle 3)
 * Stage 2 introduces the first genuinely measured numbers in Growth OS. Mixing
 * them with fixtures under one banner would make BOTH untrustworthy: a user
 * cannot tell which half is real, so they discount all of it.
 *
 * So provenance is per-metric:
 *
 *   `live`         counted from the workspace's own CRM rows, right now
 *   `fixture`      a Stage 1 placeholder, still visibly badged as demo
 *   `unavailable`  no source connected — renders as "Not connected", NEVER 0
 *
 * The snapshot's own provenance is `live` only when every metric on it is
 * live. While any fixture remains it stays `fixture`, so the demo banner
 * remains truthful about the page as a whole.
 *
 * ⚠️ A CRM figure is real but SMALL — it counts seeded demo contacts in
 * development. "Real" here means "actually counted from the database", not
 * "reflects a real business". The seed data is fictional and labelled as such.
 *
 * @see docs/product/product-principles.md (Principle 3)
 * @see apps/web/src/lib/fixtures/growth-demo.ts
 */

import { and, count, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { Actor, GrowthSnapshot, MetricValue, WorkspaceAccess } from '@growth-os/contracts';
import { schemaTables, withTenantTransaction } from '@growth-os/database';
import { buildFixtureSnapshot } from '../lib/fixtures/growth-demo';
import { getDependencies } from './dependencies';

const { acquisitions, contacts, opportunities, tasks } = schemaTables;

/** Rolling window for "this period" figures. */
const PERIOD_DAYS = 30;

interface CrmTotals {
  readonly newContacts: number;
  readonly qualifiedLeads: number;
  readonly openDeals: number;
  readonly openValueMinor: number;
  readonly openTasks: number;
  readonly overdueTasks: number;
}

/**
 * Count the workspace's CRM in one tenant-scoped transaction.
 *
 * Every query runs under `withTenantTransaction`, so row-level security
 * constrains them independently of the explicit `workspace_id` predicates.
 */
async function readCrmTotals(workspaceId: string): Promise<CrmTotals> {
  const since = new Date(Date.now() - PERIOD_DAYS * 86_400_000);
  const now = new Date();

  return withTenantTransaction(getDependencies().db, workspaceId, async (tx) => {
    const [newContacts] = await tx
      .select({ value: count() })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), gte(contacts.createdAt, since)));

    const [qualified] = await tx
      .select({ value: count() })
      .from(acquisitions)
      .where(
        and(
          eq(acquisitions.workspaceId, workspaceId),
          isNotNull(acquisitions.qualifiedAt),
          gte(acquisitions.capturedAt, since),
        ),
      );

    const [open] = await tx
      .select({
        value: count(),
        total: sql<string>`coalesce(sum(${opportunities.estimatedValueMinor}), 0)`,
      })
      .from(opportunities)
      .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.status, 'open')));

    const [openTasks] = await tx
      .select({ value: count() })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'open')));

    const [overdue] = await tx
      .select({ value: count() })
      .from(tasks)
      .where(
        and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'open'), lt(tasks.dueAt, now)),
      );

    return {
      newContacts: newContacts?.value ?? 0,
      qualifiedLeads: qualified?.value ?? 0,
      openDeals: open?.value ?? 0,
      openValueMinor: Number(open?.total ?? 0),
      openTasks: openTasks?.value ?? 0,
      overdueTasks: overdue?.value ?? 0,
    };
  });
}

function currency(valueMinor: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    maximumFractionDigits: 0,
  }).format(valueMinor / 100);
}

/**
 * Build the dashboard snapshot.
 *
 * CRM metrics are counted live. SEO, call and revenue metrics remain fixtures
 * or unavailable, because no source for them exists yet — and saying so is the
 * whole point.
 */
export async function buildGrowthSnapshot(
  _actor: Actor,
  workspace: WorkspaceAccess,
  generatedAt: string,
): Promise<GrowthSnapshot> {
  const fixture = buildFixtureSnapshot(workspace.workspaceId, workspace.workspaceName, generatedAt);
  const totals = await readCrmTotals(workspace.workspaceId);

  const liveMetrics: MetricValue[] = [
    {
      key: 'new_contacts',
      label: 'New contacts',
      value: totals.newContacts,
      formatted: String(totals.newContacts),
      unit: 'count',
      // Counted from this workspace's own rows, right now.
      provenance: 'live',
      polarity: 'higher_is_better',
      description: `Added in the last ${PERIOD_DAYS} days.`,
    },
    {
      key: 'qualified_leads',
      label: 'Qualified leads',
      value: totals.qualifiedLeads,
      formatted: String(totals.qualifiedLeads),
      unit: 'count',
      provenance: 'live',
      polarity: 'higher_is_better',
      description: 'Acquisitions marked as worth pursuing.',
    },
    {
      key: 'open_deals',
      label: 'Open opportunities',
      value: totals.openDeals,
      formatted: String(totals.openDeals),
      unit: 'count',
      provenance: 'live',
      polarity: 'higher_is_better',
    },
    {
      key: 'pipeline_value',
      label: 'Open pipeline value',
      value: totals.openValueMinor,
      formatted: currency(totals.openValueMinor),
      unit: 'currency',
      provenance: 'live',
      polarity: 'higher_is_better',
      // Named explicitly so nobody reads estimated pipeline as booked revenue.
      description: 'Estimated value of open deals — not realised revenue.',
    },
    {
      key: 'open_tasks',
      label: 'Open tasks',
      value: totals.openTasks,
      formatted: String(totals.openTasks),
      unit: 'count',
      provenance: 'live',
      polarity: 'lower_is_better',
      description: totals.overdueTasks > 0 ? `${totals.overdueTasks} overdue.` : 'None overdue.',
    },
  ];

  // Metrics with no source yet. Kept from Stage 1 and still badged — removing
  // them would hide the gap rather than state it.
  const remainingFixtures = fixture.metrics.filter((metric) =>
    ['calls', 'attributed_revenue', 'missed_calls', 'seo_visibility'].includes(metric.key),
  );

  const metrics = [...liveMetrics, ...remainingFixtures];

  // The page-level banner stays honest: `fixture` while ANY metric is not live.
  const allLive = metrics.every((metric) => metric.provenance === 'live');

  return {
    ...fixture,
    provenance: allLive ? 'live' : 'fixture',
    headline: {
      ...fixture.headline,
      description:
        'Composite score. Still a fixture — it needs SEO and revenue signals that do not exist yet.',
    },
    metrics,
  };
}
