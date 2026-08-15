/**
 * Stub for the `server-only` package.
 *
 * `server-only` is a BUILD-TIME MARKER: importing it from a client component
 * makes the Next.js bundler fail, which is the whole point. It has no runtime
 * behaviour, and it is not resolvable outside that bundler — so a Vitest run
 * that imports a server module fails on the import rather than on anything the
 * test is about.
 *
 * Aliased to this file rather than removed from the modules under test: the
 * marker is a real control, and deleting it to make a test pass would be
 * removing a guard to test the thing it guards.
 */
export {};
