/**
 * The Growth OS navigation manifest.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One declarative description of the entire product surface — used to render
 * the sidebar AND to resolve the catch-all placeholder route. That single
 * source is why every navigation link works: an entry cannot exist in the
 * sidebar without the placeholder route knowing how to render it, so there are
 * no dead links and no 404s.
 *
 * WHY DECLARE UNBUILT MODULES AT ALL
 * The navigation IS the product architecture made visible. Showing the shape
 * of the whole system — with each unbuilt destination honestly labelled with
 * its roadmap stage — communicates the plan without pretending anything is
 * finished. Principle 3 applied to navigation: an unbuilt surface must not
 * render a convincing fake.
 *
 * Kept in sync with docs/product/feature-map.md.
 */

import type { GrowthLoopStage } from '@growth-os/contracts';

export type ModuleStatus = 'built' | 'partial' | 'planned';

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly status: ModuleStatus;
  /** Roadmap stage that delivers this. Rendered on the placeholder page. */
  readonly stage: number;
  /** Which part of the growth loop this serves. Every feature declares one. */
  readonly loopStage?: GrowthLoopStage;
  /** Shown on the placeholder so the destination explains itself. */
  readonly description?: string;
}

export interface NavGroup {
  readonly id: string;
  /** Absent for the top-level group, which renders without a heading. */
  readonly label?: string;
  readonly items: readonly NavItem[];
}

export const NAVIGATION: readonly NavGroup[] = [
  {
    id: 'home',
    items: [
      {
        id: 'dashboard',
        label: 'Home',
        href: '/dashboard',
        status: 'partial',
        stage: 1,
        loopStage: 'measure',
        description: 'Growth overview and ranked opportunities.',
      },
    ],
  },
  {
    id: 'growth',
    label: 'Growth',
    items: [
      {
        id: 'growth-overview',
        label: 'Overview',
        href: '/growth/overview',
        status: 'planned',
        stage: 15,
        loopStage: 'measure',
        description: 'The full loop in one view: found → traffic → captured → converted → revenue.',
      },
      {
        id: 'opportunities',
        label: 'Opportunities',
        href: '/growth/opportunities',
        status: 'planned',
        stage: 7,
        loopStage: 'optimise',
        description:
          'Every action Growth AI recommends, ranked by expected revenue, with evidence.',
      },
    ],
  },
  {
    id: 'seo',
    label: 'SEO',
    items: [
      {
        id: 'seo-overview',
        label: 'Overview',
        href: '/seo/overview',
        status: 'planned',
        stage: 4,
        loopStage: 'get_found',
        description: 'Technical health, visibility and content performance.',
      },
      {
        id: 'site-audit',
        label: 'Site audit',
        href: '/seo/site-audit',
        status: 'planned',
        stage: 4,
        loopStage: 'get_found',
        description: 'Crawl-driven technical findings, ranked by estimated impact.',
      },
      {
        id: 'keywords',
        label: 'Keywords',
        href: '/seo/keywords',
        status: 'planned',
        stage: 6,
        loopStage: 'get_found',
        description: 'Tracked keywords with position history and page mapping.',
      },
      {
        id: 'pages',
        label: 'Pages',
        href: '/seo/pages',
        status: 'planned',
        stage: 4,
        loopStage: 'get_traffic',
        description: 'Page-level performance from crawl and Search Console data.',
      },
      {
        id: 'content',
        label: 'Content',
        href: '/seo/content',
        status: 'planned',
        stage: 8,
        loopStage: 'get_traffic',
        description: 'Briefs, on-page optimisation and content decay detection.',
      },
      {
        id: 'local-seo',
        label: 'Local SEO',
        href: '/seo/local',
        status: 'planned',
        stage: 9,
        loopStage: 'get_found',
        description: 'Google Business Profile, reviews and local rank grids.',
      },
      {
        id: 'ai-search',
        label: 'AI search',
        href: '/seo/ai-search',
        status: 'planned',
        stage: 20,
        loopStage: 'get_found',
        description: 'Visibility and citation tracking in AI-mediated answers.',
      },
      {
        id: 'competitors',
        label: 'Competitors',
        href: '/seo/competitors',
        status: 'planned',
        stage: 6,
        loopStage: 'get_found',
        description: 'Share of visibility against tracked competitors.',
      },
    ],
  },
  {
    id: 'customers',
    label: 'Customers',
    items: [
      {
        id: 'contacts',
        label: 'Contacts',
        href: '/customers/contacts',
        status: 'built',
        stage: 2,
        loopStage: 'convert',
        description: 'People, with full interaction history and source provenance.',
      },
      {
        id: 'pipeline',
        label: 'Pipeline',
        href: '/customers/pipeline',
        status: 'built',
        stage: 2,
        loopStage: 'book_sell',
        description: 'Deals by stage and value.',
      },
      {
        id: 'tasks',
        label: 'Tasks',
        href: '/customers/tasks',
        status: 'built',
        stage: 2,
        loopStage: 'convert',
        description: 'Work assigned to people — and, later, to agents.',
      },
      {
        id: 'companies',
        label: 'Companies',
        href: '/customers/companies',
        status: 'built',
        stage: 2,
        loopStage: 'convert',
        description: 'Organisations that contacts belong to.',
      },
      {
        id: 'import',
        label: 'Import',
        href: '/customers/import',
        status: 'built',
        stage: 2,
        loopStage: 'capture',
        description: 'Bring an existing contact list in from a spreadsheet.',
      },
      {
        id: 'conversations',
        label: 'Conversations',
        href: '/customers/conversations',
        status: 'planned',
        stage: 14,
        loopStage: 'convert',
        description: 'One threaded inbox across email, SMS, calls and chat.',
      },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    items: [
      {
        id: 'growth-ai',
        label: 'Growth AI',
        href: '/ai/growth',
        status: 'partial',
        stage: 7,
        loopStage: 'optimise',
        description: 'The strategist agent. Typed tool boundary exists; no model connected.',
      },
      {
        id: 'voice-agents',
        label: 'Voice agents',
        href: '/ai/voice',
        status: 'planned',
        stage: 13,
        loopStage: 'capture',
        description: 'AI receptionists that answer, qualify and book through validated services.',
      },
      {
        id: 'automations',
        label: 'Automations',
        href: '/ai/automations',
        status: 'planned',
        stage: 12,
        loopStage: 'convert',
        description: 'Trigger → condition → action workflows with replayable run history.',
      },
    ],
  },
  {
    id: 'conversion',
    label: 'Conversion',
    items: [
      {
        id: 'calendar',
        label: 'Calendar',
        href: '/conversion/calendar',
        status: 'planned',
        stage: 11,
        loopStage: 'book_sell',
        description: 'Availability and appointments, with concurrency-safe booking.',
      },
      {
        id: 'forms',
        label: 'Forms',
        href: '/conversion/forms',
        status: 'planned',
        stage: 10,
        loopStage: 'capture',
        description: 'Embeddable capture forms with source and session stitching.',
      },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      {
        id: 'reports',
        label: 'Reports',
        href: '/analytics/reports',
        status: 'planned',
        stage: 15,
        loopStage: 'measure',
        description: 'Client-ready reporting that leads with revenue, not rankings.',
      },
      {
        id: 'attribution',
        label: 'Attribution',
        href: '/analytics/attribution',
        status: 'planned',
        stage: 15,
        loopStage: 'measure',
        description: 'Keyword → click → call → lead → appointment → customer → revenue.',
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        id: 'integrations',
        label: 'Integrations',
        href: '/system/integrations',
        status: 'planned',
        stage: 5,
        description: 'Search Console, Google Business Profile, calendars and telephony.',
      },
      {
        id: 'crm-fields',
        label: 'Tags & fields',
        href: '/system/crm-fields',
        status: 'built',
        stage: 2,
        description: 'Tags and custom contact fields for this workspace.',
      },
      {
        id: 'settings',
        label: 'Settings',
        href: '/system/settings',
        status: 'planned',
        stage: 2,
        description: 'Workspace configuration, members and roles.',
      },
    ],
  },
];

/** Flat list of every navigation item. */
export const ALL_NAV_ITEMS: readonly NavItem[] = NAVIGATION.flatMap((group) => group.items);

/**
 * Resolve a navigation item from catch-all route segments.
 *
 * Used by `app/(app)/[...module]/page.tsx` so that every declared destination
 * renders an honest placeholder rather than a 404.
 */
export function findNavItemByPath(segments: readonly string[]): NavItem | undefined {
  const href = `/${segments.join('/')}`;
  return ALL_NAV_ITEMS.find((item) => item.href === href);
}

export const STATUS_LABEL: Readonly<Record<ModuleStatus, string>> = {
  built: 'Available',
  partial: 'In progress',
  planned: 'Planned',
};
