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
export type {
  UserRow,
  NewUserRow,
  SessionRow,
  NewSessionRow,
  PasswordResetTokenRow,
} from './schema/identity';
export type {
  AgencyRow,
  WorkspaceRow,
  MembershipRow,
  AgencyMembershipRow,
  NewWorkspaceRow,
  NewMembershipRow,
} from './schema/tenancy';
export type { AuditEventRow, NewAuditEventRow } from './schema/audit';

/**
 * Integration test harness.
 *
 * Exported from the package root so suites in OTHER packages (the CRM service
 * tests) get the same restricted-role connection this package's own tests use.
 * Without that, a service suite would quietly run as the owner and prove
 * nothing about row-level security.
 *
 * Test-only. Nothing in the application imports it, and `createTestHarness`
 * throws unless `TEST_DATABASE_URL` is set.
 */
export {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  type TestHarness,
} from './testing/harness';
