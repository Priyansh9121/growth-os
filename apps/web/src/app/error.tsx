'use client';

/**
 * Root error boundary.
 *
 * SECURITY CONSTRAINT
 * Renders `error.digest` — a server-generated hash — and NEVER `error.message`
 * or the stack. In production Next.js already redacts server error messages,
 * but relying on that alone would mean a client-thrown error could still
 * surface internals. The digest is what makes a user's report traceable to the
 * real log record without exposing anything.
 *
 * @see docs/engineering/error-handling.md
 */
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Reaches the browser console and any client telemetry, not the user's screen.
    console.error('[boundary] unhandled error', { digest: error.digest });
  }, [error]);

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-h1 text-text">Something went wrong</h1>
        <p className="mt-2 text-body text-text-muted">
          The error has been recorded. Try again, and if it keeps happening quote the reference
          below.
        </p>
        {error.digest ? (
          <p className="mt-4 font-mono text-caption text-text-subtle">Reference {error.digest}</p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-md border border-line px-4 py-2 text-body text-text-muted transition-colors duration-[120ms] hover:border-line-strong hover:text-text focus-visible:outline-none"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
