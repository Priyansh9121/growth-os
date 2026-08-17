/**
 * Origin normalisation and matching.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One definition of what an origin is, used by site registration, by the
 * allowed-origin check, and by attribution. Three implementations of "is this
 * the same site?" would disagree on exactly the cases that matter.
 *
 * ⚠️ WHAT ORIGIN MATCHING IS FOR, AND WHAT IT IS NOT
 * `Origin` is a browser-supplied header. A browser sets it honestly; `curl`,
 * a script, or anything else sets it to whatever it likes. So this raises the
 * cost of embedding someone else's form on a hostile page — **it is not, and
 * must never be described as, a tenancy control.** Tenancy comes from the
 * public key resolving to exactly one workspace (ADR-0026 §5).
 */

/**
 * Reduce a URL-ish string to a canonical origin.
 *
 * Returns `null` when the input cannot be parsed with confidence. Never a
 * repaired guess: a half-parsed origin that "looks close" would match the
 * wrong thing, and matching the wrong origin is worse than matching none.
 */
export function normaliseOrigin(input: string | null | undefined): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;

  // A bare `null` is what a browser sends for a sandboxed or opaque origin.
  // It is a real value and it is not a site.
  if (trimmed === 'null') return null;

  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname.length === 0) return null;

    // `url.origin` already strips default ports, the path, the query and any
    // credentials — the last of which matters, because
    // `https://evil.test@abcplumbing.test` has hostname `abcplumbing.test`
    // and would fool a naive string comparison.
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is `candidate` permitted by `allowed`?
 *
 * EXACT MATCH ONLY, after normalisation. No subdomain wildcards and no
 * suffix matching, deliberately:
 *
 *   - suffix matching makes `evil-abcplumbing.test` match `abcplumbing.test`;
 *   - subdomain wildcards on a host with user content (`*.wordpress.com`,
 *     `*.myshopify.com`) permit every other tenant of that platform.
 *
 * An empty allow-list means ANY origin, which is the correct default for a
 * form whose entire purpose is to be embedded on sites we may not know about
 * yet. That is a deliberate open default, not an oversight — the tenancy
 * guarantee does not depend on it.
 */
export function isOriginAllowed(
  candidate: string | null | undefined,
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) return true;

  const normalised = normaliseOrigin(candidate);
  if (normalised === null) return false;

  return allowed.some((entry) => normaliseOrigin(entry) === normalised);
}

/**
 * Is this origin one of ours?
 *
 * The hosted form at `/f/<key>` posts from the application's own origin, which
 * is always permitted regardless of a form's allow-list. Otherwise configuring
 * allowed origins would silently break the hosted form and the admin preview —
 * a support call with no obvious cause.
 */
export function isFirstPartyOrigin(candidate: string | null | undefined, appUrl: string): boolean {
  const normalised = normaliseOrigin(candidate);
  return normalised !== null && normalised === normaliseOrigin(appUrl);
}
