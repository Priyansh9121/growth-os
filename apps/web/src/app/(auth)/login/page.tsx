/**
 * The sign-in page — Growth OS's flagship threshold surface.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Composes the login experience specified in docs/design/login-experience.md.
 * The 3D lattice is NOT rendered here: it lives in the root layout's
 * `GrowthFieldHost`, so it survives the navigation to `/dashboard` and can
 * animate continuously across it (ADR-0008).
 *
 * A Server Component. It redirects an already-authenticated visitor away
 * before any markup is sent, so a signed-in user following a stale link does
 * not see a login form they do not need.
 *
 * LAYOUT
 * Asymmetric by design: the concept headline sits left, in the lattice's
 * space, so the eye meets the argument before the form — while the cursor is
 * already in the autofocused email field.
 *
 * @see docs/design/login-experience.md §3
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { sanitiseRedirect } from '@growth-os/auth';
import { GrowthMark } from '@growth-os/ui';
import { LoginForm, LoginSuccessMark } from '../../../features/login/login-form';
import { StaticLattice } from '../../../features/growth-field/static-lattice';
import { getAuthContext } from '../../../server/auth-context';

export const metadata: Metadata = { title: 'Sign in' };

/** Session state must never be cached. */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = typeof params['next'] === 'string' ? params['next'] : undefined;

  // Open-redirect defence applied server-side, before the value is handed to
  // the client. A client-side check would not be a control.
  const next = sanitiseRedirect(rawNext, '/dashboard');

  // An authenticated visitor has no business on the login page.
  const existing = await getAuthContext();
  if (existing) redirect(next);

  return (
    <main
      id="main"
      // 100dvh, not 100vh: mobile browser chrome would otherwise clip the
      // submit button below the fold.
      className="relative flex min-h-dvh flex-col lg:grid lg:grid-cols-[1.15fr_auto] lg:items-center lg:gap-16 lg:px-16 xl:px-24"
    >
      {/* ---- Brand, top-left on every breakpoint ---- */}
      <div className="absolute top-6 left-6 z-10 flex items-center gap-2.5 lg:top-10 lg:left-10">
        <GrowthMark size={22} className="text-signal" />
        <span className="text-body font-semibold tracking-tight">Growth OS</span>
      </div>

      {/* ---- Concept panel. Desktop only: on mobile the lattice becomes a
             compact motif above the card, and this copy would push the form
             below the fold. ---- */}
      <section className="hidden lg:flex lg:flex-col lg:gap-10">
        <div className="relative">
          <StaticLattice className="h-[380px] w-full opacity-45" />
        </div>
        <div className="max-w-md">
          <h2 className="text-h2 text-balance text-text">
            The operating system for demand, conversion and revenue.
          </h2>
          <p className="mt-3 text-body text-text-muted">
            Growth OS connects search visibility, lead capture, AI agents and your pipeline into one
            measurable loop — so you can see which work produced revenue, not just rankings.
          </p>
        </div>
      </section>

      {/* ---- Sign-in card ---- */}
      <section className="flex flex-1 items-center justify-center px-5 py-16 lg:flex-none lg:px-0 lg:py-0">
        <div className="w-full max-w-[400px]">
          {/* Mobile identity motif, in place of the desktop concept panel. */}
          <div className="mb-8 lg:hidden">
            <StaticLattice
              variant="compact"
              className="mx-auto h-32 w-full max-w-[280px] opacity-60"
            />
          </div>

          <div className="gos-glass rounded-xl border border-line-strong p-7 shadow-lg sm:p-8">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-h1 tracking-tight text-text">Welcome back</h1>
                <p className="mt-1.5 text-body text-text-muted">Sign in to your growth workspace</p>
              </div>
              <LoginSuccessMark />
            </div>

            <LoginForm next={next} />
          </div>

          <p className="mt-6 text-center text-caption text-text-subtle">
            Growth OS · Stage 1 development build
          </p>
        </div>
      </section>
    </main>
  );
}
