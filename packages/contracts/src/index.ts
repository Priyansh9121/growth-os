/**
 * @growth-os/contracts — shared types, schemas, typed errors and the AI tool
 * contract.
 *
 * This package performs no I/O and depends on nothing internal. It is the
 * vocabulary every other package speaks.
 *
 * NOTE: `./env` is intentionally NOT re-exported here. It reads `process.env`
 * and is server-only; keeping it behind a separate entry point prevents a
 * client component from pulling secrets into the browser bundle.
 */
export * from './errors/index';
export * from './tenancy/index';
export * from './auth/index';
export * from './growth/index';
export * from './crm/index';
export * from './forms/index';
export * from './ai/index';
