/**
 * Roles and capabilities for the Growth OS tenancy model.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The single, exhaustive definition of what each role may do. Every
 * authorization decision in the product resolves through this file.
 *
 * WHY A STATIC MATRIX RATHER THAN DATABASE ROWS
 * No customer requires custom roles. A database-backed permission system adds
 * a join to every authorization check plus an administration surface, for a
 * requirement that does not exist. A static matrix is exhaustively type-checked
 * at compile time, trivially unit-testable, and free at runtime.
 *
 * Because `noUncheckedIndexedAccess` is enabled, a missing entry in this matrix
 * is `undefined` rather than a silently-permissive lookup — a capability that
 * has not been granted cannot accidentally read as granted.
 *
 * @see docs/decisions/ADR-0005-multi-tenancy-model.md
 * @see docs/architecture/multi-tenancy.md
 */

/**
 * Roles held against a workspace — the tenancy boundary.
 * Ordered weakest to strongest; `WORKSPACE_ROLE_RANK` depends on this order.
 */
export const WORKSPACE_ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Roles held against an agency, which grant transitive workspace access. */
export const AGENCY_ROLES = ['agency_member', 'agency_admin', 'agency_owner'] as const;
export type AgencyRole = (typeof AGENCY_ROLES)[number];

/**
 * Numeric rank used when a user reaches one workspace by two paths (a direct
 * membership and an agency membership). The stronger role wins — never the
 * most recently evaluated one, which would make access order-dependent.
 */
export const WORKSPACE_ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * Capabilities use `scope:resource:action`.
 *
 * Prefer adding a capability over reusing a loosely-related one: an
 * over-broad capability is how a viewer ends up able to export data.
 */
export const CAPABILITIES = [
  // Workspace data
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'workspace:export',

  // Membership administration
  'workspace:members:read',
  'workspace:members:invite',
  'workspace:members:remove',
  'workspace:members:update_role',

  // Operational data (CRM, SEO, conversations) — Stage 2+
  'workspace:data:read',
  'workspace:data:write',
  'workspace:data:delete',

  // Integrations and credentials
  'workspace:integrations:read',
  'workspace:integrations:manage',

  // AI agents
  'workspace:ai:query',
  'workspace:ai:approve_action',
  'workspace:ai:configure_autonomy',

  // Billing
  'workspace:billing:read',
  'workspace:billing:manage',

  // Audit
  'workspace:audit:read',

  /**
   * CRM (Stage 2).
   *
   * These use a four-segment form, `workspace:crm:<resource>:<action>`, rather
   * than the three-segment form used above. The CRM has enough distinct
   * resources that folding them into the generic `workspace:data:*`
   * capabilities would make "may this role archive a contact?" unanswerable
   * without also granting the ability to delete integrations.
   *
   * Read and write are separated per resource so that a future Reception role
   * can manage tasks without editing the pipeline, and a Marketing role can
   * read opportunities without moving deals.
   */
  'workspace:crm:contacts:read',
  'workspace:crm:contacts:write',
  'workspace:crm:contacts:archive',

  /**
   * Data lifecycle (Stage 2.5). Each is separate from `contacts:write` and
   * from each other, because they are not degrees of the same act:
   *
   *  - `merge`  irreversibly folds two customers into one
   *  - `erase`  irreversibly destroys identity
   *  - `import` writes thousands of rows in one action
   *
   * Someone who can fix a typo should not thereby be able to do any of them.
   */
  'workspace:crm:contacts:merge',
  'workspace:crm:contacts:erase',
  'workspace:crm:contacts:import',

  /** Applying an existing tag is daily work; defining the vocabulary is not. */
  'workspace:crm:tags:apply',
  'workspace:crm:tags:manage',

  /**
   * Custom field DEFINITIONS are schema for the workspace. Values are ordinary
   * contact data and ride on `contacts:write`, so no separate write capability
   * exists for them — one would only invite an inconsistent grant.
   */
  'workspace:crm:custom_fields:manage',

  'workspace:crm:companies:read',
  'workspace:crm:companies:write',
  'workspace:crm:opportunities:read',
  'workspace:crm:opportunities:write',
  'workspace:crm:pipelines:manage',
  'workspace:crm:tasks:read',
  'workspace:crm:tasks:write',
  'workspace:crm:activities:read',

  /**
   * Lead capture (Stage 3).
   *
   * Separate from the CRM capabilities on purpose. A form is a PUBLIC surface
   * on a customer's website: publishing one exposes an endpoint to the open
   * internet, and that is a different act from editing a contact. Folding it
   * into `crm:contacts:write` would mean anyone who can fix a typo can also
   * put a form on the public web.
   *
   * `sites:manage` is separate again, because a web property is shared with
   * the Stage 4 crawler and Search Console later — registering one is a claim
   * about what the business owns, not a form setting.
   */
  'workspace:forms:read',
  'workspace:forms:manage',
  'workspace:sites:read',
  'workspace:sites:manage',

  // Agency scope
  'agency:read',
  'agency:update',
  'agency:workspaces:create',
  'agency:workspaces:remove',
  'agency:members:read',
  'agency:members:manage',
  'agency:billing:manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities held by a `viewer`. Deliberately excludes export. */
const VIEWER_CAPABILITIES = [
  'workspace:read',
  'workspace:members:read',
  'workspace:data:read',
  'workspace:integrations:read',
  // A viewer sees the CRM but changes nothing, and cannot export (above).
  'workspace:crm:contacts:read',
  'workspace:crm:companies:read',
  'workspace:crm:opportunities:read',
  'workspace:crm:tasks:read',
  'workspace:crm:activities:read',
  // A viewer SEES which forms exist and how they are performing. Publishing
  // one opens an endpoint on the public internet, which is administrative.
  'workspace:forms:read',
  'workspace:sites:read',
] as const satisfies readonly Capability[];

/** A day-to-day operator: reads and writes operational data. */
const MEMBER_CAPABILITIES = [
  ...VIEWER_CAPABILITIES,
  'workspace:data:write',
  'workspace:export',
  'workspace:ai:query',
  // Day-to-day CRM operation: create and edit records, move deals, run tasks.
  // Deliberately WITHOUT contacts:archive and pipelines:manage — removing a
  // customer record and reshaping the sales process are administrative acts,
  // not daily ones.
  'workspace:crm:contacts:write',
  'workspace:crm:companies:write',
  'workspace:crm:opportunities:write',
  'workspace:crm:tasks:write',
  // Applying an EXISTING tag is daily work. Defining the vocabulary is not,
  // and neither is merging, erasing or bulk-importing.
  'workspace:crm:tags:apply',
] as const satisfies readonly Capability[];

/** Trusted operator: everything except deleting the workspace and billing. */
const ADMIN_CAPABILITIES = [
  ...MEMBER_CAPABILITIES,
  'workspace:update',
  'workspace:data:delete',
  'workspace:members:invite',
  'workspace:members:remove',
  'workspace:members:update_role',
  'workspace:integrations:manage',
  'workspace:ai:approve_action',
  'workspace:ai:configure_autonomy',
  'workspace:audit:read',
  'workspace:billing:read',
  'workspace:crm:contacts:archive',
  'workspace:crm:pipelines:manage',
  // Irreversible or bulk operations on customer data. Admin and owner only.
  'workspace:crm:contacts:merge',
  'workspace:crm:contacts:erase',
  'workspace:crm:contacts:import',
  'workspace:crm:tags:manage',
  'workspace:crm:custom_fields:manage',
  // Publishing a form opens a public endpoint on the internet, and registering
  // a site is a claim about what the business owns. Both are administrative.
  'workspace:forms:manage',
  'workspace:sites:manage',
] as const satisfies readonly Capability[];

const OWNER_CAPABILITIES = [
  ...ADMIN_CAPABILITIES,
  'workspace:delete',
  'workspace:billing:manage',
] as const satisfies readonly Capability[];

/**
 * The workspace capability matrix.
 *
 * Sets rather than arrays: membership tests run on every authorization check,
 * and O(1) beats O(n) on a hot path that is also security-critical.
 */
export const WORKSPACE_CAPABILITIES: Readonly<Record<WorkspaceRole, ReadonlySet<Capability>>> = {
  viewer: new Set(VIEWER_CAPABILITIES),
  member: new Set(MEMBER_CAPABILITIES),
  admin: new Set(ADMIN_CAPABILITIES),
  owner: new Set(OWNER_CAPABILITIES),
};

const AGENCY_MEMBER_CAPABILITIES = [
  'agency:read',
  'agency:members:read',
] as const satisfies readonly Capability[];

const AGENCY_ADMIN_CAPABILITIES = [
  ...AGENCY_MEMBER_CAPABILITIES,
  'agency:update',
  'agency:workspaces:create',
  'agency:workspaces:remove',
] as const satisfies readonly Capability[];

const AGENCY_OWNER_CAPABILITIES = [
  ...AGENCY_ADMIN_CAPABILITIES,
  'agency:members:manage',
  'agency:billing:manage',
] as const satisfies readonly Capability[];

export const AGENCY_CAPABILITIES: Readonly<Record<AgencyRole, ReadonlySet<Capability>>> = {
  agency_member: new Set(AGENCY_MEMBER_CAPABILITIES),
  agency_admin: new Set(AGENCY_ADMIN_CAPABILITIES),
  agency_owner: new Set(AGENCY_OWNER_CAPABILITIES),
};

/**
 * The workspace role an agency role confers on the agency's client workspaces.
 *
 * WHY THIS MAPPING EXISTS
 * Agency access is transitive rather than copied into `memberships` rows, so
 * that detaching a client from an agency is a single nullable-column update
 * rather than a fan-out data migration that could partially fail.
 *
 * `agency_member` deliberately maps to `member`, not `admin`: an agency
 * employee operating a client account should not be able to remove the
 * client's own owner.
 */
export const AGENCY_ROLE_TO_WORKSPACE_ROLE: Readonly<Record<AgencyRole, WorkspaceRole>> = {
  agency_member: 'member',
  agency_admin: 'admin',
  agency_owner: 'admin',
};

/**
 * Does this workspace role grant this capability?
 *
 * Total function: an unknown role or an unlisted capability returns `false`.
 * Authorization helpers must never throw on unexpected input, because a throw
 * in an error path can be handled into an allow.
 */
export function workspaceRoleHasCapability(role: WorkspaceRole, capability: Capability): boolean {
  return WORKSPACE_CAPABILITIES[role]?.has(capability) ?? false;
}

export function agencyRoleHasCapability(role: AgencyRole, capability: Capability): boolean {
  return AGENCY_CAPABILITIES[role]?.has(capability) ?? false;
}

/** Returns the stronger of two workspace roles. */
export function strongerWorkspaceRole(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  return WORKSPACE_ROLE_RANK[a] >= WORKSPACE_ROLE_RANK[b] ? a : b;
}

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function isAgencyRole(value: string): value is AgencyRole {
  return (AGENCY_ROLES as readonly string[]).includes(value);
}
