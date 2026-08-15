/**
 * Ambient types for component tests.
 *
 * `@testing-library/jest-dom/vitest` augments Vitest's `Assertion` interface
 * with DOM matchers (`toBeInTheDocument`, `toHaveFocus`, …). The augmentation
 * only applies where the module is in TypeScript's program, and the shared
 * Vitest setup file lives outside this app's `tsconfig.json` include path — so
 * without this reference, `npm run typecheck` fails on every a11y assertion
 * while the tests themselves pass. Importing it here puts the augmentation in
 * scope for the whole app.
 */
import '@testing-library/jest-dom/vitest';
