/**
 * The complete Growth OS database schema.
 *
 * Every table lives in a domain-named file; this barrel is what Drizzle Kit
 * reads to generate migrations, so a table missing from here is a table
 * missing from the migration.
 */
export * from './identity';
export * from './tenancy';
export * from './audit';
export * from './crm';
export * from './crm-lifecycle';
