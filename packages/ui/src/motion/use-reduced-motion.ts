'use client';

/**
 * Reduced-motion preference, as a live React value.
 *
 * WHY NOT JUST THE CSS MEDIA QUERY
 * CSS covers CSS transitions. It cannot stop us from MOUNTING a WebGL canvas,
 * and for the login lattice the correct behaviour is not "animate slower" —
 * it is "do not create the scene at all". That decision happens in JavaScript,
 * so JavaScript needs the preference.
 *
 * WHY IT SUBSCRIBES TO CHANGES
 * Reading the query once on mount is the common implementation and it is
 * wrong: a user who enables the OS setting while the tab is open keeps getting
 * animation until they reload. Subscribing means the preference takes effect
 * immediately.
 *
 * SSR
 * `useSyncExternalStore` takes a server snapshot of `false`, so the server
 * renders the full-motion markup and the client corrects on hydration. The
 * alternative — assuming reduced motion on the server — would make the first
 * paint for every user the reduced variant, then swap. Neither is perfect;
 * this one keeps the common case stable, and no layout depends on the value.
 *
 * @see docs/design/motion-system.md
 */

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** `true` when the user has asked for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
