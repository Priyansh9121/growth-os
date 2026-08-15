'use client';

/**
 * The Growth OS application shell.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Sidebar, top bar and content frame — plus the entrance choreography that
 * completes the login transition.
 *
 * THE ENTRANCE RULE
 * The choreography runs only when the transition machine says a genuine
 * sign-in just happened. On an authenticated refresh the machine initialises
 * at `complete`, `shouldPlayEntrance` is false, and the shell renders
 * immediately with no animation. That is the whole mechanism preventing an
 * animation replay on every page load — no storage flag, nothing to
 * desynchronise.
 *
 * @see docs/decisions/ADR-0008-login-transition-architecture.md
 * @see docs/design/motion-system.md §The dashboard entrance sequence
 */

import { useEffect, useState, type ReactNode } from 'react';
import { DASHBOARD_ENTRANCE } from '@growth-os/ui';
import type { SessionUserView } from '@growth-os/contracts';
import { useAuthTransition } from '../../features/auth-transition/provider';
import { shouldPlayEntrance } from '../../features/auth-transition/machine';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

/** Total choreography duration, from `DASHBOARD_ENTRANCE`'s last step. */
const ENTRANCE_TOTAL_MS = Math.max(...DASHBOARD_ENTRANCE.map((step) => step.delay + step.duration));

export interface AppShellProps {
  readonly user: SessionUserView;
  readonly children: ReactNode;
}

export function AppShell({ user, children }: AppShellProps) {
  const { state, dispatch } = useAuthTransition();

  /**
   * Captured ONCE at mount. If it were read live, the shell would stop
   * animating mid-sequence the moment the machine advanced to `complete`,
   * cutting the choreography short.
   */
  const [playEntrance] = useState(() => shouldPlayEntrance(state));

  // Tell the machine the entrance finished. This is what advances
  // `dashboard_enter → complete`, which in turn unmounts the WebGL canvas.
  useEffect(() => {
    if (!playEntrance) return;

    const timer = setTimeout(() => {
      dispatch({ type: 'ENTRANCE_COMPLETE' });
    }, ENTRANCE_TOTAL_MS);

    return () => clearTimeout(timer);
  }, [playEntrance, dispatch]);

  /**
   * Build the CSS custom properties that drive one entrance step.
   * Returns `undefined` when not animating, so no animation class is applied
   * and there is no flash of an initial `opacity: 0` state.
   */
  function step(id: (typeof DASHBOARD_ENTRANCE)[number]['id']) {
    if (!playEntrance) return undefined;
    const config = DASHBOARD_ENTRANCE.find((candidate) => candidate.id === id);
    if (!config) return undefined;
    return {
      className: 'gos-enter',
      style: {
        '--gos-enter-delay': `${config.delay}ms`,
        '--gos-enter-duration': `${config.duration}ms`,
      } as React.CSSProperties,
    };
  }

  const shellStep = step('shell');
  const sidebarStep = step('sidebar');
  const topbarStep = step('topbar');

  return (
    <div
      className={`flex min-h-dvh bg-canvas ${shellStep?.className ?? ''}`}
      style={shellStep?.style}
    >
      <div className={sidebarStep?.className} style={sidebarStep?.style}>
        <Sidebar />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          `relative z-30` on the WRAPPER, not just the header.
          The header's own z-index orders it within this div; without a
          z-index here, the wrapper sits at `auto` and `main` — later in the
          DOM — paints above it, so the account dropdown and workspace
          switcher were covered by page content. Caught by an E2E sign-out
          test whose click was intercepted.
        */}
        <div className={`relative z-30 ${topbarStep?.className ?? ''}`} style={topbarStep?.style}>
          <TopBar user={user} />
        </div>

        <main id="main" className="min-w-0 flex-1 px-5 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Wraps a dashboard section in one step of the entrance choreography.
 *
 * Exposed so page-level content can join the sequence without the shell
 * needing to know what those sections are.
 */
export function EntranceStep({
  id,
  index = 0,
  children,
}: {
  readonly id: 'hero' | 'cards' | 'ai';
  /** Position within a staggered group. Adds 40ms per item. */
  readonly index?: number;
  readonly children: ReactNode;
}) {
  const { state } = useAuthTransition();
  const [playEntrance] = useState(() => shouldPlayEntrance(state));

  if (!playEntrance) return <>{children}</>;

  const config = DASHBOARD_ENTRANCE.find((candidate) => candidate.id === id);
  if (!config) return <>{children}</>;

  return (
    <div
      className="gos-enter"
      style={
        {
          '--gos-enter-delay': `${config.delay + index * 40}ms`,
          '--gos-enter-duration': `${config.duration}ms`,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
