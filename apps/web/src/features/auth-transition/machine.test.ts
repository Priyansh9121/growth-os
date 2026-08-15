/**
 * The login → dashboard transition machine.
 *
 * WHY THIS FILE EXISTS
 * These are the tests that would be impossible if the transition were a set of
 * booleans and `setTimeout` chains. A pure reducer means the entire
 * choreography — including its failure modes — is verifiable in milliseconds
 * with no browser, which is most of the justification for ADR-0008.
 *
 * @see docs/decisions/ADR-0008-login-transition-architecture.md
 */

import { describe, expect, it } from 'vitest';
import {
  initialState,
  isBusy,
  isConverging,
  shouldPlayEntrance,
  shouldRenderScene,
  transitionReducer,
  type TransitionEvent,
  type TransitionPhase,
  type TransitionState,
} from './machine';

/** Apply a sequence of events, for readable multi-step assertions. */
function run(start: TransitionState, ...events: TransitionEvent[]): TransitionState {
  return events.reduce(transitionReducer, start);
}

describe('the successful sign-in path', () => {
  it('traverses every phase in order', () => {
    let state = initialState('idle');

    state = transitionReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('submitting');

    state = transitionReducer(state, { type: 'AUTH_SUCCEEDED' });
    expect(state.phase).toBe('authenticated');

    state = transitionReducer(state, { type: 'PREP_COMPLETE' });
    expect(state.phase).toBe('transitioning');

    state = transitionReducer(state, { type: 'CONVERGENCE_COMPLETE' });
    expect(state.phase).toBe('dashboard_enter');

    state = transitionReducer(state, { type: 'ENTRANCE_COMPLETE' });
    expect(state.phase).toBe('complete');
  });

  it('releases the scene only at completion', () => {
    // This is what unmounts the WebGL canvas and frees the context.
    const phases: TransitionPhase[] = [
      'idle',
      'submitting',
      'authenticated',
      'transition_prep',
      'transitioning',
      'dashboard_enter',
    ];

    for (const phase of phases) {
      expect(shouldRenderScene(initialState(phase))).toBe(true);
    }
    expect(shouldRenderScene(initialState('complete'))).toBe(false);
  });
});

describe('the failure path', () => {
  it('returns to idle and clears the message', () => {
    let state = run(
      initialState('idle'),
      { type: 'SUBMIT' },
      {
        type: 'AUTH_FAILED',
        message: 'Email or password is incorrect.',
      },
    );

    expect(state.phase).toBe('auth_failed');
    expect(state.errorMessage).toBe('Email or password is incorrect.');

    state = transitionReducer(state, { type: 'RESET' });
    expect(state.phase).toBe('idle');
    expect(state.errorMessage).toBeNull();
  });

  it('allows retrying directly from a failure', () => {
    const state = run(
      initialState('idle'),
      { type: 'SUBMIT' },
      { type: 'AUTH_FAILED', message: 'nope' },
      { type: 'SUBMIT' },
    );

    expect(state.phase).toBe('submitting');
    // The stale error must clear on resubmit, or it would be announced again
    // while the new attempt is still in flight.
    expect(state.errorMessage).toBeNull();
  });
});

describe('illegal transitions', () => {
  it('ignores events that do not apply to the current phase', () => {
    const idle = initialState('idle');

    // A late response from a cancelled request must not crash the page or
    // advance the machine from a phase it never left.
    expect(transitionReducer(idle, { type: 'AUTH_SUCCEEDED' })).toBe(idle);
    expect(transitionReducer(idle, { type: 'CONVERGENCE_COMPLETE' })).toBe(idle);
    expect(transitionReducer(idle, { type: 'ENTRANCE_COMPLETE' })).toBe(idle);
  });

  it('returns the identical object reference when ignoring an event', () => {
    // Referential equality lets React bail out of re-rendering rather than
    // churning on every ignored event.
    const state = initialState('submitting');
    expect(transitionReducer(state, { type: 'SUBMIT' })).toBe(state);
  });

  it('cannot skip from submitting straight to the entrance', () => {
    const state = run(initialState('idle'), { type: 'SUBMIT' }, { type: 'CONVERGENCE_COMPLETE' });
    expect(state.phase).toBe('submitting');
  });
});

describe('FORCE_COMPLETE — the watchdog', () => {
  it('is reachable from every phase', () => {
    // An animation bug must never be able to trap a user. Navigation has
    // already happened independently, so forcing completion simply drops them
    // onto the dashboard.
    const phases: TransitionPhase[] = [
      'idle',
      'submitting',
      'auth_failed',
      'authenticated',
      'transition_prep',
      'transitioning',
      'dashboard_enter',
      'complete',
    ];

    for (const phase of phases) {
      expect(transitionReducer(initialState(phase), { type: 'FORCE_COMPLETE' }).phase).toBe(
        'complete',
      );
    }
  });
});

describe('reduced flow', () => {
  it('skips the whole sequence on AUTH_SUCCEEDED', () => {
    // A reduced-motion user must not sit through a sequence they asked not to
    // see, and on a device with no WebGL there is no scene to converge.
    const state = run(initialState('idle', true), { type: 'SUBMIT' }, { type: 'AUTH_SUCCEEDED' });
    expect(state.phase).toBe('complete');
  });

  it('never plays the dashboard entrance', () => {
    expect(
      shouldPlayEntrance({ phase: 'transitioning', errorMessage: null, reducedFlow: true }),
    ).toBe(false);
    expect(
      shouldPlayEntrance({ phase: 'dashboard_enter', errorMessage: null, reducedFlow: true }),
    ).toBe(false);
  });

  it('still renders the static composition on the login screen', () => {
    // The fallback is a designed alternative, not an absence. Gating the host
    // on reducedFlow would leave these users on a bare background.
    expect(shouldRenderScene({ phase: 'idle', errorMessage: null, reducedFlow: true })).toBe(true);
  });

  it('can be toggled at any time', () => {
    const state = transitionReducer(initialState('idle'), {
      type: 'SET_REDUCED_FLOW',
      reducedFlow: true,
    });
    expect(state.reducedFlow).toBe(true);
  });
});

describe('entrance replay prevention', () => {
  it('does not play the entrance when the app booted on an app route', () => {
    // The whole mechanism: a refresh of /dashboard initialises at `complete`,
    // so the choreography cannot replay. No storage flag, nothing to expire.
    expect(shouldPlayEntrance(initialState('complete'))).toBe(false);
  });

  it('plays the entrance only during a genuine sign-in', () => {
    expect(shouldPlayEntrance(initialState('transitioning'))).toBe(true);
    expect(shouldPlayEntrance(initialState('dashboard_enter'))).toBe(true);
    expect(shouldPlayEntrance(initialState('idle'))).toBe(false);
    expect(shouldPlayEntrance(initialState('submitting'))).toBe(false);
  });
});

describe('derived predicates', () => {
  it('isBusy covers every phase where the form must be locked', () => {
    expect(isBusy('idle')).toBe(false);
    expect(isBusy('auth_failed')).toBe(false);
    expect(isBusy('submitting')).toBe(true);
    expect(isBusy('authenticated')).toBe(true);
    expect(isBusy('transitioning')).toBe(true);
  });

  it('isConverging matches the phases where the lattice collapses', () => {
    expect(isConverging('transition_prep')).toBe(true);
    expect(isConverging('transitioning')).toBe(true);
    expect(isConverging('idle')).toBe(false);
    expect(isConverging('dashboard_enter')).toBe(false);
  });
});
