/**
 * Test-only exports.
 *
 * Kept behind the `@growth-os/database/testing` subpath so the harness — which
 * creates database roles and truncates tables — cannot be imported by
 * application code through the package's main entry point.
 */
export * from './harness';
