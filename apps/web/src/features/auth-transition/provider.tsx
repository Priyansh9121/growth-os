'use client';

/**
 * React binding for the transition state machine.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Hosts the reducer in the ROOT layout, so the state survives the
 * `/login → /dashboard` navigation. Route-group layouts would unmount, which
 * is precisely what makes a continuous transition impossible in the naive
 * implementation.
 *
 * THE ENTRANCE-REPLAY RULE
 * The initial phase is derived ONCE, at mount, from the route the app booted
 * on:
 *   - booted on `/login`  → `idle`     (a sign-in may follow)
 *   - booted anywhere else → `complete` (already inside the app)
 *
 * A refresh of `/dashboard` therefore initialises at `complete` and the
 * entrance cannot replay. No sessionStorage flag, nothing to expire, nothing
 * to desynchronise. This is the whole mechanism.
 *
 * @see docs/decisions/ADR-0008-login-transition-architecture.md
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useReducedMotion } from '@growth-os/ui';
import {
  initialState,
  transitionReducer,
  TRANSITION_WATCHDOG_MS,
  type TransitionEvent,
  type TransitionState,
} from './machine';

interface TransitionContextValue {
  readonly state: TransitionState;
  readonly dispatch: (event: TransitionEvent) => void;
}

const TransitionContext = createContext<TransitionContextValue | null>(null);

export function AuthTransitionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const prefersReducedMotion = useReducedMotion();

  // Lazy initialiser: runs once at mount. Later navigations do NOT re-derive
  // the phase, which is what keeps a client-side route change from resetting
  // a transition that is mid-flight.
  const [state, dispatch] = useReducer(transitionReducer, pathname, (path) =>
    initialState(path?.startsWith('/login') ? 'idle' : 'complete'),
  );

  // Reduced motion may be toggled at any time, including mid-session.
  useEffect(() => {
    dispatch({ type: 'SET_REDUCED_FLOW', reducedFlow: prefersReducedMotion });
  }, [prefersReducedMotion]);

  // Watchdog. Armed whenever the machine leaves `idle` on the success path,
  // disarmed on arrival at a terminal phase. Guarantees the sequence cannot
  // stall forever if an animation callback never fires.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const inFlight =
      state.phase === 'authenticated' ||
      state.phase === 'transition_prep' ||
      state.phase === 'transitioning' ||
      state.phase === 'dashboard_enter';

    if (!inFlight) {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      return;
    }

    if (watchdogRef.current) return; // Already armed for this sequence.

    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      dispatch({ type: 'FORCE_COMPLETE' });
    }, TRANSITION_WATCHDOG_MS);

    return () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };
  }, [state.phase]);

  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <TransitionContext.Provider value={value}>{children}</TransitionContext.Provider>;
}

/**
 * Read the transition state.
 *
 * Throws outside the provider rather than returning a default: a component
 * that silently believes the transition is `complete` would skip its entrance
 * with no indication anything was wrong, which is far harder to debug than an
 * immediate error.
 */
export function useAuthTransition(): TransitionContextValue {
  const value = useContext(TransitionContext);
  if (!value) {
    throw new Error('useAuthTransition must be used within <AuthTransitionProvider>.');
  }
  return value;
}
