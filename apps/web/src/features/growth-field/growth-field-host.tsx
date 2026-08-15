'use client';

/**
 * The persistent scene host.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Rendered by the ROOT layout as a fixed background layer, so the WebGL
 * context survives the `/login → /dashboard` navigation. That survival is the
 * entire reason the transition can be continuous — a canvas mounted inside the
 * `(auth)` route group would unmount on navigation and guarantee a visible
 * break.
 *
 * WHAT IT RENDERS, BY PHASE
 *   idle … dashboard_enter  → the 3D lattice (or the static fallback)
 *   complete                → NOTHING
 *
 * That last row matters as much as the first: at `complete` the canvas
 * unmounts and the WebGL context is released, so the dashboard pays no ongoing
 * 3D cost, and a direct authenticated load of `/dashboard` (which initialises
 * at `complete`) never creates a context at all.
 *
 * @see docs/decisions/ADR-0008-login-transition-architecture.md
 * @see docs/design/3d-system.md
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { useReducedMotion } from '@growth-os/ui';
import { useAuthTransition } from '../auth-transition/provider';
import { isConverging, shouldRenderScene } from '../auth-transition/machine';
import { resolveSceneCapability, type SceneCapability } from './capability';
import { StaticLattice } from './static-lattice';

/**
 * three.js and R3F are pulled in only here.
 *
 * `ssr: false` because WebGL has no server rendering, and the dynamic import
 * keeps ~150KB of 3D out of the initial bundle — the login form is interactive
 * before any of this arrives.
 */
const LatticeScene = dynamic(() => import('./lattice-scene'), {
  ssr: false,
  // No loading placeholder: the static lattice is already on screen underneath
  // and swapping it for a spinner would be a downgrade.
  loading: () => null,
});

export function GrowthFieldHost() {
  const { state, dispatch } = useAuthTransition();
  const prefersReducedMotion = useReducedMotion();

  /**
   * Starts as `null` (undecided) rather than `'full'`, so the server render and
   * the first client paint agree on the lightweight path. Deciding during
   * render instead would cause a hydration mismatch, because the server cannot
   * know the device's capabilities.
   */
  const [capability, setCapability] = useState<SceneCapability | null>(null);

  useEffect(() => {
    setCapability(resolveSceneCapability({ prefersReducedMotion }));
  }, [prefersReducedMotion]);

  // Tell the machine to skip the whole sequence when we cannot render it.
  // Without this, a fallback device would sit in `authenticated` waiting for a
  // convergence callback that can never fire — the watchdog would rescue it,
  // but only after a needless pause.
  useEffect(() => {
    if (capability === null) return;
    dispatch({ type: 'SET_REDUCED_FLOW', reducedFlow: capability === 'fallback' });
  }, [capability, dispatch]);

  const handleConverged = useCallback(() => {
    dispatch({ type: 'CONVERGENCE_COMPLETE' });
  }, [dispatch]);

  // `authenticated` is a beat where the card confirms success before the
  // structure starts moving. Advancing on the next frame keeps the sequence
  // driven by the machine rather than by a chain of timers.
  useEffect(() => {
    if (state.phase !== 'authenticated') return;
    const frame = requestAnimationFrame(() => dispatch({ type: 'PREP_COMPLETE' }));
    return () => cancelAnimationFrame(frame);
  }, [state.phase, dispatch]);

  if (!shouldRenderScene(state)) return null;

  const converging = isConverging(state.phase);
  const fadingOut = state.phase === 'dashboard_enter';

  return (
    <div
      // aria-hidden + pointer-events-none: the scene is decorative, is not in
      // the tab order, and never intercepts a click meant for the form.
      aria-hidden="true"
      className={[
        'pointer-events-none fixed inset-0 -z-10 overflow-hidden',
        'transition-opacity ease-standard',
        fadingOut ? 'opacity-0 duration-[520ms]' : 'opacity-100 duration-[900ms]',
      ].join(' ')}
    >
      {capability === 'full' ? (
        <LatticeScene
          convergenceTarget={converging || fadingOut ? 1 : 0}
          activity={state.phase === 'submitting' ? 1 : 0}
          onConverged={handleConverged}
        />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <StaticLattice className="h-full max-h-[520px] w-full max-w-[820px] opacity-70" />
        </div>
      )}
    </div>
  );
}
