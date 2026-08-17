/**
 * @growth-os/forms — lead capture.
 *
 * BOUNDARY: depends on @growth-os/contracts, @growth-os/crm and
 * @growth-os/database. It must NEVER import @growth-os/auth (cycle),
 * @growth-os/ui, React, Next.js, anything in apps/, or `node:fs`.
 *
 * ⚠️ THIS PACKAGE NEVER INSERTS A CRM ROW. Contacts, acquisitions and
 * opportunities belong to `ingestAcquisition` in @growth-os/crm. A second
 * ingestion path would mean two answers to "how is a lead deduplicated?"
 * (ADR-0021).
 */
export * from './shared/context';
export * from './forms/service';
export * from './public/resolve';
export * from './public/honeypot';
export * from './public/abuse';
export * from './public/submit';
export * from './public/submissions';
export * from './tracking/sanitise';
