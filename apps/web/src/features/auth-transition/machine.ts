/**
 * The login → dashboard transition state machine.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * A single, pure, explicit model of the sign-in threshold. The 3D scene, the
 * login card and the dashboard shell are all READERS of this state; none of
 * them owns a piece of it.
 *
 * WHY A MACHINE RATHER THAN BOOLEANS
 * The obvious implementation — `isSubmitting`, `isTransitioning`,
 * `hasEntered`, each in a different component, coordinated by `setTimeout` —
 * has a combinatorial number of reachable states, most of them nonsense
 * (submitting AND complete), and it cannot be tested without a browser. A
 * reducer over a discriminated union makes the illegal states unrepresentable
 * and the whole flow unit-testable in milliseconds.
 *
 * THE INVARIANT THAT MATTERS MOST
 * **Navigation is never gated on this machine.** `router.push()` happens as
 * soon as authentication succeeds, in parallel with `AUTH_SUCCEEDED`. If every
 * line of animation code below threw, the user would still arrive,
 * authenticated, at the dashboard. Animation observes; it does not control.
 *
 * @see docs/decisions/ADR-0008-login-transition-architecture.md
 * @see docs/design/login-experience.md §6
 */

/** Phases, in the order a successful sign-in traverses them. */
export type TransitionPhase =
  /** Login form at rest. */
  | 'idle'
  /** Credentials submitted; awaiting the server. Duration is unknown and unpadded. */
  | 'submitting'
  /** Authentication failed. Terminal for this attempt; returns to `idle`. */
  | 'auth_failed'
  /** Authenticated. Navigation has been requested in parallel. */
  | 'authenticated'
  /** Scene snapshots its pose so convergence starts from where it actually is. */
  | 'transition_prep'
  /** Lattice converges, camera pushes forward. */
  | 'transitioning'
  /** Shell choreography runs. */
  | 'dashboard_enter'
  /** Settled. The WebGL context is released here. */
  | 'complete';

export interface TransitionState {
  readonly phase: TransitionPhase;
  /** Present only in `auth_failed`. Rendered by the login card. */
  readonly errorMessage: string | null;
  /**
   * True when the whole sequence should be skipped — reduced motion, no WebGL,
   * or a low-powered device. Carried in state rather than read per component so
   * every reader agrees.
   */
  readonly reducedFlow: boolean;
}

export type TransitionEvent =
  | { readonly type: 'SUBMIT' }
  | { readonly type: 'AUTH_SUCCEEDED' }
  | { readonly type: 'AUTH_FAILED'; readonly message: string }
  | { readonly type: 'PREP_COMPLETE' }
  | { readonly type: 'CONVERGENCE_COMPLETE' }
  | { readonly type: 'ENTRANCE_COMPLETE' }
  /** Watchdog, reduced motion, or an animation failure. Always accepted. */
  | { readonly type: 'FORCE_COMPLETE' }
  /** Dismiss an error and return to `idle`. */
  | { readonly type: 'RESET' }
  | { readonly type: 'SET_REDUCED_FLOW'; readonly reducedFlow: boolean };

export function initialState(phase: TransitionPhase, reducedFlow = false): TransitionState {
  return { phase, errorMessage: null, reducedFlow };
}

/**
 * Which phases each event may be applied from.
 *
 * Declared as data so the legal graph is readable at a glance and so tests can
 * assert that every phase/event pair behaves. An event arriving in a phase not
 * listed here is IGNORED rather than throwing — a late response from a
 * cancelled request must not crash the page.
 */
const ALLOWED_FROM: Record<
  Exclude<TransitionEvent['type'], 'FORCE_COMPLETE' | 'SET_REDUCED_FLOW'>,
  readonly TransitionPhase[]
> = {
  SUBMIT: ['idle', 'auth_failed'],
  AUTH_SUCCEEDED: ['submitting'],
  AUTH_FAILED: ['submitting'],
  PREP_COMPLETE: ['authenticated'],
  CONVERGENCE_COMPLETE: ['transition_prep', 'transitioning'],
  ENTRANCE_COMPLETE: ['dashboard_enter'],
  RESET: ['auth_failed'],
};

function canApply(event: TransitionEvent, phase: TransitionPhase): boolean {
  if (event.type === 'FORCE_COMPLETE' || event.type === 'SET_REDUCED_FLOW') return true;
  return ALLOWED_FROM[event.type].includes(phase);
}

/**
 * Pure reducer.
 *
 * Returns the SAME object reference when an event is not applicable, so React
 * bails out of re-rendering rather than churning on ignored events.
 */
export function transitionReducer(state: TransitionState, event: TransitionEvent): TransitionState {
  if (!canApply(event, state.phase)) return state;

  switch (event.type) {
    case 'SUBMIT':
      return { ...state, phase: 'submitting', errorMessage: null };

    case 'AUTH_SUCCEEDED':
      // Under a reduced flow, jump straight to the end: a reduced-motion user
      // must not sit through a sequence they asked not to see, and there is no
      // scene to converge.
      return state.reducedFlow
        ? { ...state, phase: 'complete', errorMessage: null }
        : { ...state, phase: 'authenticated', errorMessage: null };

    case 'AUTH_FAILED':
      return { ...state, phase: 'auth_failed', errorMessage: event.message };

    case 'PREP_COMPLETE':
      return { ...state, phase: 'transitioning' };

    case 'CONVERGENCE_COMPLETE':
      return { ...state, phase: 'dashboard_enter' };

    case 'ENTRANCE_COMPLETE':
      return { ...state, phase: 'complete' };

    case 'FORCE_COMPLETE':
      // Deliberately reachable from ANY phase, including `idle` and
      // `auth_failed`. The watchdog must be able to end the sequence no matter
      // where it stalled — an animation bug must never trap a user.
      return { ...state, phase: 'complete', errorMessage: null };

    case 'RESET':
      return { ...state, phase: 'idle', errorMessage: null };

    case 'SET_REDUCED_FLOW':
      return { ...state, reducedFlow: event.reducedFlow };
  }
}

/**
 * Should the background field be present at all?
 *
 * Note this is NOT gated on `reducedFlow`. A reduced-motion or no-WebGL user
 * still sees the static lattice composition on the login screen — `reducedFlow`
 * selects *which* composition renders, and makes the machine skip the
 * convergence phases. Gating here instead would leave those users on a bare
 * background, which was never the intent: the fallback is a designed
 * alternative, not an absence.
 *
 * At `complete` nothing renders, which is what releases the WebGL context and
 * keeps the dashboard free of 3D cost.
 */
export function shouldRenderScene(state: TransitionState): boolean {
  return state.phase !== 'complete';
}

/** Is the lattice actively converging? */
export function isConverging(phase: TransitionPhase): boolean {
  return phase === 'transition_prep' || phase === 'transitioning';
}

/**
 * Should the dashboard shell play its entrance choreography?
 *
 * True only during a genuine sign-in. An authenticated page refresh
 * initialises the machine at `complete`, so this is false and the entrance
 * cannot replay — no storage flag, nothing to desynchronise.
 */
export function shouldPlayEntrance(state: TransitionState): boolean {
  return (
    !state.reducedFlow && (state.phase === 'transitioning' || state.phase === 'dashboard_enter')
  );
}

/** Is the login form busy? */
export function isBusy(phase: TransitionPhase): boolean {
  return phase !== 'idle' && phase !== 'auth_failed';
}

/**
 * Watchdog ceiling, milliseconds.
 *
 * Comfortably longer than the designed ~1.2s sequence, short enough that a
 * stalled animation does not become a stuck page. On expiry the machine is
 * forced to `complete`; navigation has already happened independently, so the
 * user is simply on the dashboard.
 */
export const TRANSITION_WATCHDOG_MS = 2600;
