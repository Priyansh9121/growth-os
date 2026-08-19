/**
 * @growth-os/sites — web properties.
 *
 * BOUNDARY: depends on @growth-os/contracts, @growth-os/database and
 * @growth-os/net. It must NEVER import @growth-os/forms, @growth-os/crm,
 * @growth-os/auth, @growth-os/ui, React, Next.js, or anything in apps/.
 *
 * Extracted from @growth-os/forms at Stage 4, which is the trigger ADR-0029 §4
 * named: a second, non-forms consumer (the crawler) now needs to know which
 * websites a workspace owns, and must not import lead capture to find out.
 *
 * ⚠️ VERIFICATION IS THE PERMISSION BOUNDARY FOR CRAWLING. Without it Growth OS
 * is an arbitrary internet scanning service anyone can drive by typing a
 * domain. See verification.ts.
 */
export * from './context';
export * from './crawls';
export * from './origin';
export * from './service';
export * from './verification';
