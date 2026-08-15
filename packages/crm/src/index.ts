/**
 * @growth-os/crm — CRM application services.
 *
 * BOUNDARY: depends on @growth-os/contracts and @growth-os/database only.
 * It must NEVER import @growth-os/auth (which would create a cycle and couple
 * the CRM to how authentication happened), @growth-os/ui, or anything in apps/.
 *
 * Every exported service takes a `CrmContext` carrying an already-authorized
 * `TenantActor`, checks a specific capability, and runs inside a tenant-scoped
 * transaction. There is deliberately no `findById(id)` — see shared/context.ts.
 */
export * from './shared/context';
export * from './shared/pagination';
export * from './identity/normalise';
export * from './events/publisher';
export * from './contacts/service';
export * from './companies/service';
export * from './acquisitions/service';
export * from './pipelines/service';
export * from './opportunities/service';
export * from './tasks/service';
export * from './activities/service';
