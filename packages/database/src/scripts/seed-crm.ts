/**
 * CRM development seed data.
 *
 * ⚠️  EVERY RECORD HERE IS FICTIONAL. No real person or business appears.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Populates a realistic CRM for local development, the dashboard, and the E2E
 * suite.
 *
 * WHY THIS WRITES THROUGH THE SERVICES RATHER THAN INSERTING ROWS
 * Direct inserts would be faster but would produce a database no real usage
 * could create: no activity timeline, no domain events, no provenance
 * validation. Seeding through the real services means the demo data exercises
 * the same code paths a user does — and a bug in `createContact` fails the
 * seed rather than lying dormant until someone clicks the button.
 *
 * Names are invented; every email uses the `.test` TLD, which RFC 6761
 * reserves as permanently unresolvable.
 *
 * @see packages/database/src/scripts/seed.ts
 */

import type { Database } from '../client';
import type { CrmContext } from '@growth-os/crm';

/** Demo contacts with deliberately varied, realistic provenance. */
interface SeedContact {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  readonly company?: string;
  readonly source: {
    readonly sourceType: string;
    readonly sourcePlatform: string;
    readonly confidence: string;
    readonly landingPath?: string;
    readonly utmCampaign?: string;
    readonly channelDetail?: string;
    /** Only ever present with confidence 'declared' — see ADR-0012. */
    readonly searchQuery?: string;
  };
  readonly opportunity?: {
    readonly title: string;
    readonly valueMinor: number;
    readonly stageName: string;
  };
}

export const SEED_CONTACTS: readonly SeedContact[] = [
  {
    firstName: 'Sarah',
    lastName: 'Mitchell',
    email: 'sarah.mitchell@example.test',
    phone: '0412 345 678',
    source: {
      sourceType: 'organic_search',
      sourcePlatform: 'google',
      // `derived`: we saw the landing page and referrer, but Google has not
      // passed the query in the referrer since 2011, so searchQuery stays NULL.
      confidence: 'derived',
      landingPath: '/emergency-plumber-melbourne',
    },
    opportunity: {
      title: 'Emergency hot water repair',
      valueMinor: 46_000,
      stageName: 'Qualified',
    },
  },
  {
    firstName: 'James',
    lastName: 'Carter',
    email: 'james.carter@example.test',
    phone: '+61 413 222 111',
    company: 'Carter Constructions',
    source: {
      sourceType: 'paid_search',
      sourcePlatform: 'google',
      // `declared`: an Ads platform reports the keyword that triggered the
      // click, so a search query here is legitimate.
      confidence: 'declared',
      landingPath: '/blocked-drains',
      utmCampaign: 'drains-melbourne-2026',
      searchQuery: 'blocked drain emergency melbourne',
    },
    opportunity: {
      title: 'Commercial drain inspection',
      valueMinor: 185_000,
      stageName: 'Quote',
    },
  },
  {
    firstName: 'Olivia',
    lastName: 'Chen',
    email: 'olivia.chen@example.test',
    phone: '0455 987 321',
    source: {
      sourceType: 'voice',
      sourcePlatform: 'growth_os',
      confidence: 'declared',
      channelDetail: 'Tracked line — Southbank',
    },
    opportunity: {
      title: 'Bathroom renovation plumbing',
      valueMinor: 720_000,
      stageName: 'Appointment',
    },
  },
  {
    firstName: 'Daniel',
    lastName: 'Okonkwo',
    email: 'daniel.okonkwo@example.test',
    phone: '0433 118 224',
    source: {
      sourceType: 'google_business_profile',
      sourcePlatform: 'google',
      confidence: 'declared',
      channelDetail: 'Map pack — Richmond',
    },
    opportunity: {
      title: 'Gas heater service',
      valueMinor: 32_000,
      stageName: 'Won',
    },
  },
  {
    firstName: 'Priya',
    lastName: 'Raman',
    email: 'priya.raman@example.test',
    phone: '0466 771 900',
    company: 'Riverside Cafe',
    source: {
      sourceType: 'referral',
      sourcePlatform: 'unknown',
      confidence: 'manual',
      channelDetail: 'Referred by Carter Constructions',
    },
    opportunity: {
      title: 'Cafe grease trap installation',
      valueMinor: 240_000,
      stageName: 'Contacted',
    },
  },
  {
    firstName: 'Tom',
    lastName: 'Fletcher',
    email: 'tom.fletcher@example.test',
    phone: '0400 555 212',
    source: {
      sourceType: 'website_form',
      sourcePlatform: 'growth_os',
      confidence: 'declared',
      landingPath: '/contact',
    },
    opportunity: {
      title: 'Leaking tap — quote requested',
      valueMinor: 18_000,
      stageName: 'New Lead',
    },
  },
  {
    firstName: 'Nadia',
    lastName: 'Haddad',
    email: 'nadia.haddad@example.test',
    phone: '0477 303 918',
    source: {
      sourceType: 'social',
      sourcePlatform: 'facebook',
      confidence: 'derived',
      landingPath: '/hot-water-systems',
      utmCampaign: 'winter-hot-water',
    },
    // Deliberately no opportunity: a lead that never became a deal. Conflating
    // acquisitions with opportunities would make this state unrepresentable.
  },
  {
    firstName: 'Marcus',
    lastName: 'Webb',
    email: 'marcus.webb@example.test',
    phone: '0421 664 073',
    source: {
      sourceType: 'direct',
      sourcePlatform: 'unknown',
      // `unknown` provenance is a legitimate, common state. Guessing here
      // would fabricate attribution.
      confidence: 'derived',
    },
    opportunity: {
      title: 'Annual maintenance contract',
      valueMinor: 95_000,
      stageName: 'Lost',
    },
  },
];

export const SEED_COMPANIES = [
  { name: 'Carter Constructions', website: 'carterconstructions.test' },
  { name: 'Riverside Cafe', website: 'riversidecafe.test' },
] as const;

export const SEED_TASKS = [
  { title: 'Call Sarah about hot water quote', priority: 'high', dueInDays: 0, contact: 'Sarah' },
  {
    title: 'Send drain inspection quote to James',
    priority: 'urgent',
    dueInDays: -1,
    contact: 'James',
  },
  {
    title: 'Confirm Tuesday appointment with Olivia',
    priority: 'normal',
    dueInDays: 1,
    contact: 'Olivia',
  },
  { title: 'Follow up on maintenance contract', priority: 'low', dueInDays: 5, contact: 'Marcus' },
  {
    title: 'Review Riverside Cafe site measurements',
    priority: 'normal',
    dueInDays: 3,
    contact: 'Priya',
  },
] as const;

/**
 * Seed one workspace's CRM.
 *
 * Imported dynamically by `seed.ts` so the database package does not take a
 * hard dependency on `@growth-os/crm` — which would invert the dependency
 * direction and be rejected by the boundary lint rules.
 */
export async function seedCrmForWorkspace(
  _db: Database,
  makeContext: () => CrmContext,
): Promise<{ contacts: number; opportunities: number; tasks: number }> {
  const crm = await import('@growth-os/crm');
  const context = makeContext();

  const pipeline = await crm.ensureDefaultPipeline(context);
  const stageByName = new Map(pipeline.stages.map((stage) => [stage.name, stage.id]));

  const companyIds = new Map<string, string>();
  for (const company of SEED_COMPANIES) {
    const created = await crm.createCompany(context, {
      name: company.name,
      website: company.website,
    });
    companyIds.set(company.name, created.id);
  }

  const contactIds = new Map<string, string>();
  let opportunityCount = 0;

  for (const seed of SEED_CONTACTS) {
    const { contact } = await crm.createContact(context, {
      firstName: seed.firstName,
      lastName: seed.lastName,
      email: seed.email,
      phone: seed.phone,
      ...(seed.company ? { companyId: companyIds.get(seed.company) } : {}),
      acquisition: {
        sourceType: seed.source.sourceType as never,
        sourcePlatform: seed.source.sourcePlatform as never,
        confidence: seed.source.confidence as never,
        ...(seed.source.landingPath ? { landingPath: seed.source.landingPath } : {}),
        ...(seed.source.utmCampaign ? { utmCampaign: seed.source.utmCampaign } : {}),
        ...(seed.source.channelDetail ? { channelDetail: seed.source.channelDetail } : {}),
        ...(seed.source.searchQuery ? { searchQuery: seed.source.searchQuery } : {}),
      },
    });

    contactIds.set(seed.firstName, contact.id);

    if (seed.opportunity) {
      const stageId = stageByName.get(seed.opportunity.stageName);
      await crm.createOpportunity(context, {
        title: seed.opportunity.title,
        contactId: contact.id,
        pipelineId: pipeline.id,
        ...(stageId ? { stageId } : {}),
        estimatedValueMinor: seed.opportunity.valueMinor,
      });
      opportunityCount += 1;
    }
  }

  const today = new Date();
  for (const task of SEED_TASKS) {
    const due = new Date(today);
    due.setDate(due.getDate() + task.dueInDays);
    await crm.createTask(context, {
      title: task.title,
      priority: task.priority as never,
      dueAt: due.toISOString(),
      ...(contactIds.has(task.contact) ? { contactId: contactIds.get(task.contact) } : {}),
    });
  }

  return {
    contacts: SEED_CONTACTS.length,
    opportunities: opportunityCount,
    tasks: SEED_TASKS.length,
  };
}
