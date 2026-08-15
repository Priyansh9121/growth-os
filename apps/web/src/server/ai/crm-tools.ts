import 'server-only';

/**
 * Read-only CRM tools for Growth AI.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Extends the Stage 1 tool registry with the CRM. Every tool passes through
 * the same guard chain — capability → autonomy → budget → input schema →
 * application service → output schema — and receives a `TenantActor`, never a
 * database handle.
 *
 * ⚠️ ALL TOOLS ARE `effect: 'read'`. Stage 2 gives agents NO mutation
 * capability. Write tools require the approval workflow that arrives with the
 * agent runtime at Stage 7; shipping them before that would mean an agent
 * could change customer records with no human in the loop, which is precisely
 * what the autonomy model exists to prevent.
 *
 * DATA MINIMISATION IS THE DESIGN CONSTRAINT HERE
 * These outputs are deliberately NOT `ContactView`. Tool output becomes model
 * context — it is sent to a third-party API, may be retained by that provider,
 * and can be echoed back to a user. So each tool returns the narrowest shape
 * that answers its question:
 *
 *   - `crm.getPipelineSummary`  aggregates only. No person appears at all.
 *   - `crm.listRecentLeads`     first name + source. NO email, NO phone.
 *   - `crm.getContactSummary`   one contact, still without raw contact details.
 *   - `crm.getOpenTasks`        titles and dates. No contact details.
 *
 * A model does not need someone's phone number to advise on what to do next,
 * so it never receives one.
 *
 * @see docs/architecture/ai-agent-architecture.md
 * @see docs/decisions/ADR-0011-crm-domain-model.md
 */

import { z } from 'zod';
import { AutonomyLevel, defineTool, SOURCE_TYPE_LABELS } from '@growth-os/contracts';
import {
  getContact,
  listAcquisitionsForContact,
  listContacts,
  listOpportunities,
  listPipelines,
  listTasks,
} from '@growth-os/crm';
import { getDependencies } from '../dependencies';
import { getEventPublisher } from '../crm-context';
import type { CrmContext } from '@growth-os/crm';
import type { ToolContext } from '@growth-os/contracts';

/**
 * Build a CRM context from a tool invocation.
 *
 * The `TenantActor` comes from the ToolContext, which the runtime constructed
 * from an authorized request. An agent cannot name a workspace — the scope is
 * supplied to it, never chosen by it.
 */
function crmContextFor(context: ToolContext): CrmContext {
  return {
    deps: { db: getDependencies().db, events: getEventPublisher() },
    tenant: context.tenant,
    correlationId: context.runId,
  };
}

/** Aggregate pipeline health. Contains no personal data whatsoever. */
export const getPipelineSummaryTool = defineTool({
  name: 'crm.getPipelineSummary',
  description:
    'Returns aggregate pipeline health for the active workspace: deal counts and total value ' +
    'per stage, plus win/loss totals. Contains no personal data. Use this for questions about ' +
    'pipeline value, stage distribution or conversion, never to look up an individual.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    pipelineName: z.string(),
    currency: z.string(),
    openDealCount: z.number(),
    openValueMinor: z.number(),
    stages: z.array(
      z.object({
        name: z.string(),
        category: z.enum(['open', 'won', 'lost']),
        dealCount: z.number(),
        valueMinor: z.number(),
      }),
    ),
  }),
  effect: 'read',
  requiredCapability: 'workspace:crm:opportunities:read',
  minimumAutonomy: AutonomyLevel.RECOMMEND,
  costUnits: 1,

  async execute(_input, context) {
    const crm = crmContextFor(context);
    const pipelines = await listPipelines(crm);
    const pipeline = pipelines[0];

    if (!pipeline) {
      return {
        pipelineName: 'None configured',
        currency: 'AUD',
        openDealCount: 0,
        openValueMinor: 0,
        stages: [],
      };
    }

    const openStages = pipeline.stages.filter((stage) => stage.category === 'open');

    return {
      pipelineName: pipeline.name,
      currency: pipeline.currency,
      openDealCount: openStages.reduce((sum, stage) => sum + stage.openOpportunityCount, 0),
      openValueMinor: openStages.reduce((sum, stage) => sum + stage.openValueMinor, 0),
      stages: pipeline.stages.map((stage) => ({
        name: stage.name,
        category: stage.category,
        dealCount: stage.openOpportunityCount,
        valueMinor: stage.openValueMinor,
      })),
    };
  },
});

/**
 * Recent leads, by source.
 *
 * Returns first name only, and NO email or phone. The question an agent asks
 * of this tool is "where are leads coming from and are we following up?" —
 * which needs a channel breakdown and an identifier to reference, not a
 * contactable record.
 */
export const listRecentLeadsTool = defineTool({
  name: 'crm.listRecentLeads',
  description:
    'Returns the most recent contacts with their acquisition source. Returns first names and ' +
    'source only — no email addresses or phone numbers. Use this to reason about where leads ' +
    'come from and whether they are being followed up.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(25).default(10),
  }),
  outputSchema: z.object({
    leads: z.array(
      z.object({
        contactId: z.string(),
        firstName: z.string(),
        source: z.string(),
        sourceConfidence: z.enum(['declared', 'derived', 'inferred', 'manual']).nullable(),
        openOpportunityCount: z.number(),
        createdAt: z.string(),
      }),
    ),
  }),
  effect: 'read',
  requiredCapability: 'workspace:crm:contacts:read',
  minimumAutonomy: AutonomyLevel.RECOMMEND,
  costUnits: 1,

  async execute(input, context) {
    const page = await listContacts(crmContextFor(context), {
      limit: input.limit,
      sort: 'createdAt',
      direction: 'desc',
    });

    return {
      leads: page.items.map((contact) => ({
        contactId: contact.id,
        // First name only. A surname plus a source is meaningfully more
        // identifying, and adds nothing to the agent's reasoning.
        firstName: contact.firstName,
        source: contact.firstSource
          ? SOURCE_TYPE_LABELS[contact.firstSource.sourceType]
          : 'Not recorded',
        // Confidence travels with the source so the agent can qualify its own
        // statements rather than presenting derived data as fact (ADR-0012).
        sourceConfidence: contact.firstSource?.confidence ?? null,
        openOpportunityCount: contact.openOpportunityCount,
        createdAt: contact.createdAt,
      })),
    };
  },
});

/**
 * Summary of ONE contact, by id.
 *
 * Still excludes email and phone: an agent advising on next actions does not
 * need to be able to contact someone directly, and a model that has never
 * seen a phone number cannot leak one.
 */
export const getContactSummaryTool = defineTool({
  name: 'crm.getContactSummary',
  description:
    'Returns a summary of one contact by id: display name, source history, open deal count and ' +
    'last activity. Deliberately excludes email and phone. Use after crm.listRecentLeads when ' +
    'reasoning about a specific person.',
  inputSchema: z.object({ contactId: z.uuid() }),
  outputSchema: z.object({
    contactId: z.string(),
    displayName: z.string(),
    companyName: z.string().nullable(),
    ownerName: z.string().nullable(),
    openOpportunityCount: z.number(),
    lastActivityAt: z.string().nullable(),
    acquisitions: z.array(
      z.object({
        source: z.string(),
        confidence: z.enum(['declared', 'derived', 'inferred', 'manual']),
        landingPath: z.string().nullable(),
        /** NULL unless a source system declared it. Never inferred (ADR-0012). */
        searchQuery: z.string().nullable(),
        capturedAt: z.string(),
      }),
    ),
  }),
  effect: 'read',
  requiredCapability: 'workspace:crm:contacts:read',
  minimumAutonomy: AutonomyLevel.RECOMMEND,
  costUnits: 1,

  async execute(input, context) {
    const crm = crmContextFor(context);
    // Tenant-scoped: a contact id belonging to another workspace raises
    // NotFoundError, so an agent cannot probe for other tenants' records.
    const contact = await getContact(crm, input.contactId);
    const acquisitions = await listAcquisitionsForContact(crm, input.contactId);

    return {
      contactId: contact.id,
      displayName: contact.displayName,
      companyName: contact.companyName,
      ownerName: contact.ownerName,
      openOpportunityCount: contact.openOpportunityCount,
      lastActivityAt: contact.lastActivityAt,
      acquisitions: acquisitions.map((acquisition) => ({
        source: SOURCE_TYPE_LABELS[acquisition.sourceType],
        confidence: acquisition.confidence,
        landingPath: acquisition.landingPath,
        searchQuery: acquisition.searchQuery,
        capturedAt: acquisition.capturedAt,
      })),
    };
  },
});

/** Open tasks — titles and dates only, no contact details. */
export const getOpenTasksTool = defineTool({
  name: 'crm.getOpenTasks',
  description:
    'Returns open tasks with due dates and priority, including which are overdue. Contains no ' +
    'contact details. Use to reason about follow-up load and what is slipping.',
  inputSchema: z.object({
    overdueOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  outputSchema: z.object({
    openTaskCount: z.number(),
    overdueCount: z.number(),
    tasks: z.array(
      z.object({
        title: z.string(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']),
        dueAt: z.string().nullable(),
        isOverdue: z.boolean(),
      }),
    ),
  }),
  effect: 'read',
  requiredCapability: 'workspace:crm:tasks:read',
  minimumAutonomy: AutonomyLevel.RECOMMEND,
  costUnits: 1,

  async execute(input, context) {
    const page = await listTasks(crmContextFor(context), {
      limit: input.limit,
      scope: 'all',
      status: 'open',
      ...(input.overdueOnly ? { overdueOnly: true } : {}),
    });

    return {
      openTaskCount: page.items.length,
      overdueCount: page.items.filter((task) => task.isOverdue).length,
      tasks: page.items.map((task) => ({
        title: task.title,
        priority: task.priority,
        dueAt: task.dueAt,
        isOverdue: task.isOverdue,
      })),
    };
  },
});

/** Open deal totals by source — the closest Stage 2 gets to attribution. */
export const getRevenueBySourceTool = defineTool({
  name: 'crm.getOpenValueBySource',
  description:
    'Returns open opportunity value grouped by the acquisition source that produced each deal. ' +
    'This is PIPELINE value, not realised revenue — no revenue data exists yet. Contains no ' +
    'personal data.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    currency: z.string(),
    /** Named so the model cannot mistake pipeline value for booked revenue. */
    note: z.string(),
    bySource: z.array(
      z.object({ source: z.string(), dealCount: z.number(), openValueMinor: z.number() }),
    ),
  }),
  effect: 'read',
  requiredCapability: 'workspace:crm:opportunities:read',
  minimumAutonomy: AutonomyLevel.RECOMMEND,
  costUnits: 2,

  async execute(_input, context) {
    const page = await listOpportunities(crmContextFor(context), { limit: 100, status: 'open' });

    const totals = new Map<string, { dealCount: number; openValueMinor: number }>();
    for (const deal of page.items) {
      const key = deal.sourceType ? SOURCE_TYPE_LABELS[deal.sourceType] : 'Not recorded';
      const existing = totals.get(key) ?? { dealCount: 0, openValueMinor: 0 };
      totals.set(key, {
        dealCount: existing.dealCount + 1,
        openValueMinor: existing.openValueMinor + deal.estimatedValueMinor,
      });
    }

    return {
      currency: page.items[0]?.currency ?? 'AUD',
      note:
        'Open pipeline value, not realised revenue. Revenue attribution arrives at Stage 15; ' +
        'do not present these figures as earned income.',
      bySource: [...totals.entries()].map(([source, value]) => ({ source, ...value })),
    };
  },
});

export const CRM_TOOLS = [
  getPipelineSummaryTool,
  listRecentLeadsTool,
  getContactSummaryTool,
  getOpenTasksTool,
  getRevenueBySourceTool,
] as const;
