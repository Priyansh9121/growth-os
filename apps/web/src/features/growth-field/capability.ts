/**
 * Device capability detection for the 3D scene.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Decides whether to mount WebGL at all. The four downgrade conditions in
 * `3d-system.md` §2 are implemented here, evaluated in order, first match
 * wins.
 *
 * DESIGN STANCE
 * The fallback is a *designed alternative*, not a degraded experience. Most
 * mobile users will only ever see it, so "cannot run 3D" must never mean
 * "gets a worse product".
 *
 * @see docs/design/3d-system.md §2
 */

export type SceneCapability = 'full' | 'fallback';

export interface CapabilityInput {
  readonly prefersReducedMotion: boolean;
}

/**
 * Probe for WebGL support.
 *
 * Creates a throwaway context and immediately releases it via
 * `WEBGL_lose_context`. Browsers cap simultaneous contexts (often ~16), and
 * probing without releasing would consume one for the life of the page — for
 * the login, that would leave nothing for the scene itself.
 */
export function hasWebGLSupport(): boolean {
  if (typeof document === 'undefined') return false;

  try {
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');

    if (!context) return false;

    const lose = (context as WebGLRenderingContext).getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return true;
  } catch {
    // Some privacy-hardened browsers throw rather than returning null.
    return false;
  }
}

/**
 * Heuristic for a device unlikely to hold 60fps.
 *
 * `hardwareConcurrency <= 4` is a proxy, not a measurement — it is the only
 * signal browsers expose without running a benchmark, and running a benchmark
 * on the login screen would itself cost the frames we are trying to protect.
 * Biased toward the fallback: a capable device occasionally getting the static
 * composition is a much better outcome than a weak device stuttering.
 */
export function isLowPoweredDevice(): boolean {
  if (typeof navigator === 'undefined') return true;

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores <= 4) return true;

  return false;
}

/** Coarse pointer on a narrow viewport — the mobile condition. */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(pointer: coarse) and (max-width: 767px)').matches;
}

/**
 * Resolve which composition to render.
 *
 * Server-safe: returns `'fallback'` when `window` is absent, so the first
 * server render is always the lightweight path and the client upgrades after
 * hydration if the device allows. That ordering means the login is never
 * blocked on a capability decision.
 */
export function resolveSceneCapability({ prefersReducedMotion }: CapabilityInput): SceneCapability {
  if (typeof window === 'undefined') return 'fallback';
  // Order matters: an explicit user preference outranks every device signal.
  if (prefersReducedMotion) return 'fallback';
  if (isMobileViewport()) return 'fallback';
  if (isLowPoweredDevice()) return 'fallback';
  if (!hasWebGLSupport()) return 'fallback';
  return 'full';
}
