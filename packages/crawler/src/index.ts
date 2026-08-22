/**
 * @growth-os/crawler — website crawling.
 *
 * BOUNDARY: depends on @growth-os/contracts, @growth-os/database and
 * @growth-os/net. It must NEVER import React, Next.js, @growth-os/ui,
 * @growth-os/crm, @growth-os/auth, or anything in apps/.
 *
 * ⚠️ IT NEVER OPENS A SOCKET ITSELF. Every outbound request goes through
 * `safeFetch` in @growth-os/net — robots.txt, sitemaps, verification and page
 * fetches alike. A boundary probe asserts this package cannot import
 * `node:http`, `node:https`, `node:net` or `node:dns`.
 *
 * ⚠️ IT STORES FACTS, NOT FINDINGS. `title_length = 0` is Stage 4;
 * "Missing title, severity high" is Stage 5.
 */
export * from './frontier/decide';
export * from './frontier/frontier';
export * from './robots/parse';
export * from './robots/fetch';
export * from './sitemap/parse';
export * from './sitemap/fetch';
export * from './pages/fetch';
export * from './run/crawl';
export * from './sitemap/walk';
export * from './sitemap/enqueue';
export * from './urls/normalise';
export * from './urls/scope';
export * from './links/extract';
