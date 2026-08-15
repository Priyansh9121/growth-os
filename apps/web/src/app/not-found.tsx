import Link from 'next/link';

/**
 * Dynamic, deliberately.
 *
 * Nonce-based CSP requires dynamic rendering: Next.js cannot inject a nonce
 * into a page generated at build time, and under `'strict-dynamic'` a static
 * page's unnonced scripts are blocked. Every other route is already dynamic
 * because it depends on the session cookie; this one has to say so explicitly.
 *
 * @see docs/decisions/ADR-0017-content-security-policy.md
 */
export const dynamic = 'force-dynamic';

/** 404. Deliberately plain — an error page is not a place for personality. */
export default function NotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md text-center">
        <p className="font-mono text-caption text-text-subtle">404</p>
        <h1 className="mt-2 text-h1 text-text">Page not found</h1>
        <p className="mt-2 text-body text-text-muted">
          That page does not exist, or you do not have access to it.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-md border border-line px-4 py-2 text-body text-text-muted transition-colors duration-[120ms] hover:border-line-strong hover:text-text focus-visible:outline-none"
        >
          Back to Growth OS
        </Link>
      </div>
    </main>
  );
}
