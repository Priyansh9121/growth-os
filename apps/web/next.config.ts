/**
 * Next.js configuration.
 *
 * @see docs/decisions/ADR-0006-ui-stack.md
 */
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * Internal packages ship TypeScript source with no build step (ADR-0002),
   * so Next compiles them as part of the app.
   */
  transpilePackages: [
    '@growth-os/ui',
    '@growth-os/contracts',
    '@growth-os/auth',
    '@growth-os/database',
  ],

  typescript: {
    // Type errors fail the build. A "temporarily ignore" flag here becomes
    // permanent within a week.
    ignoreBuildErrors: false,
  },

  // Next.js 16 no longer runs ESLint during `next build`, so there is no
  // `eslint` key to configure. Linting is a separate CI gate — `npm run lint`
  // in verify:all — which is where it belongs anyway: a lint failure should
  // not require a full production build to surface.

  /**
   * Security headers applied to every response.
   *
   * A Content-Security-Policy is deliberately NOT set here yet: Next.js
   * injects inline bootstrap scripts, so a correct policy needs per-request
   * nonces threaded through middleware. Doing that badly produces a policy
   * full of 'unsafe-inline', which is worse than none because it looks like
   * protection. Tracked as a Stage 2 task in docs/security/threat-model.md.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Defence in depth against MIME-sniffing an upload into a script.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Clickjacking: no part of Growth OS is intended to be framed.
          { key: 'X-Frame-Options', value: 'DENY' },
          // Do not leak internal paths (which contain workspace IDs) to
          // third-party sites the user navigates to.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Deny powerful features the product does not use.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default config;
