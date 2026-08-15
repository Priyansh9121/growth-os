/**
 * @growth-os/ui — the Growth OS design system.
 *
 * BOUNDARY: no internal dependencies. This package must never import from
 * apps/, from @growth-os/database or from @growth-os/auth — a design system
 * that knows about the database is not a design system.
 *
 * Design tokens live in `./tokens/tokens.css` and are imported by the
 * consuming app's global stylesheet, not from TypeScript.
 */
export * from './lib/cn';
export * from './primitives/index';
export * from './motion/index';
