/**
 * Root layout.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Establishes the two things that must persist across EVERY route change:
 *
 *  1. `AuthTransitionProvider` — the transition state machine. Placed here,
 *     not in a route group, because route-group layouts unmount on navigation
 *     and the machine's state must survive `/login → /dashboard`.
 *
 *  2. `GrowthFieldHost` — the WebGL scene host. Same reason: a canvas mounted
 *     inside `(auth)` would be destroyed by the navigation, making a
 *     continuous transition impossible.
 *
 * The host renders nothing once the machine reaches `complete`, so the
 * dashboard carries no 3D cost and an authenticated page load never creates a
 * WebGL context.
 *
 * @see docs/decisions/ADR-0008-login-transition-architecture.md
 */

import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { AuthTransitionProvider } from '../features/auth-transition/provider';
import { resolveRequestTheme } from '../server/theme';
import { GrowthFieldHost } from '../features/growth-field/growth-field-host';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Growth OS',
    template: '%s · Growth OS',
  },
  description:
    'The operating system for demand, conversion and revenue. SEO, CRM, AI agents and attribution in one loop.',
  // The product is entirely behind authentication; there is nothing to index
  // and indexing the login serves no purpose.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Never `maximum-scale=1` or `user-scalable=no` — blocking pinch zoom is a
  // WCAG 1.4.4 failure and makes the product unusable for low-vision users.
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0e14' },
    { media: '(prefers-color-scheme: light)', color: '#fbfbfc' },
  ],
};

/**
 * Never statically rendered: the theme depends on the session cookie. Every
 * route in this app was already `force-dynamic` before this — verified, not
 * assumed — so nothing loses static rendering by resolving it here.
 */
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // ⚠️ RESOLVED ON THE SERVER, so the correct attribute is in the first byte of
  // HTML and no wrong-theme frame is ever painted. Dark for a signed-out
  // visitor, which is what every visitor saw before this existed.
  const theme = await resolveRequestTheme();

  return (
    <html
      lang="en"
      // `suppressHydrationWarning` is kept: it was added for a client theme
      // script that no longer needs to exist, and it still costs nothing while
      // guarding the one attribute a browser extension is most likely to touch.
      data-theme={theme}
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-dvh bg-canvas text-text antialiased">
        {/* Standard skip link. First tabbable element on every page. */}
        <a
          href="#main"
          className="sr-only rounded-md bg-surface-3 px-4 py-2 text-body focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50"
        >
          Skip to main content
        </a>

        <AuthTransitionProvider>
          <GrowthFieldHost />
          {children}
        </AuthTransitionProvider>
      </body>
    </html>
  );
}
