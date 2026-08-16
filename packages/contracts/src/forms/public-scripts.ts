/**
 * Where the two customer-facing scripts are served.
 *
 * ⚠️ THESE STRINGS ARE A PUBLIC CONTRACT. They appear in snippets operators
 * paste into their own websites, so changing one breaks every page that already
 * has the old URL — an embed URL is closer to a database column than to an
 * internal path.
 *
 * They live here, in the package with no dependencies, because three places
 * need to agree on them: the instructions an operator copies, the browser tests
 * that paste those instructions into a stand-in customer page, and
 * `scripts/build-public-scripts.mjs`, which writes the files.
 *
 * The build script cannot import TypeScript, so it holds the directory as a
 * literal — the end-to-end test is what proves the two still agree. They did
 * not: the snippet advertised `/embed.js` while the build wrote
 * `/scripts/embed.js`, and every customer who pasted it would have got a page
 * with no form on it.
 */

/** The embed loader: inserts the iframe, listens for one resize message. */
export const EMBED_SCRIPT_PATH = '/scripts/embed.js';

/** The attribution tracker: reads the URL, writes one sessionStorage key. */
export const TRACKING_SCRIPT_PATH = '/scripts/track.js';
