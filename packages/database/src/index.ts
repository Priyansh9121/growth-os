/**
 * @growth-os/database — schema, connection management, tenant-scoped
 * transactions and the audit writer.
 *
 * BOUNDARY: this package may depend on @growth-os/contracts and nothing else
 * internal. It must never import from apps/ or from a domain package —
 * dependencies point downward only.
 */
export * from './client';
export * from './audit';
export * as schemaTables from './schema/index';
export { AUDIT_EVENTS, type AuditEventName } from './schema/audit';
export type { UserRow, NewUserRow, SessionRow, NewSessionRow } from './schema/identity';
export type {
  AgencyRow,
  WorkspaceRow,
  MembershipRow,
  AgencyMembershipRow,
  NewWorkspaceRow,
  NewMembershipRow,
} from './schema/tenancy';
export type { AuditEventRow, NewAuditEventRow } from './schema/audit';
