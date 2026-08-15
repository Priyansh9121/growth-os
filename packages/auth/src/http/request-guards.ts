/**
 * HTTP-boundary security helpers: CSRF origin validation, safe redirects and
 * client IP extraction.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Pure functions over primitive inputs — no framework types. That keeps them
 * usable from Next.js route handlers today and from Fastify later, and it
 * makes them testable without constructing a request object.
 *
 * @see docs/security/authentication.md
 * @see docs/security/threat-model.md
 */

/**
 * Validate that a state-changing request originated from our own application.
 *
 * WHY THIS EXISTS ALONGSIDE SameSite=Lax
 * `SameSite=Lax` blocks the classic cross-site form POST, but it is not a
 * complete defence: it does not protect against a compromised subdomain
 * (which is same-site), and browser behaviour has varied across versions and
 * privacy modes. An explicit origin check is cheap and closes both gaps.
 *
 * WHY IT FAILS CLOSED ON A MISSING HEADER
 * Browsers always send `Origin` on cross-origin requests and on same-origin
 * POSTs. A state-changing request with neither `Origin` nor `Referer` is
 * therefore anomalous, and treating "absent" as "safe" is how origin checks
 * get bypassed in practice.
 *
 * @param origin  The `Origin` header, if present.
 * @param referer The `Referer` header — fallback only.
 * @param appUrl  The canonical application origin, from validated config.
 */
export function isTrustedOrigin(
  origin: string | null | undefined,
  referer: string | null | undefined,
  appUrl: string,
): boolean {
  const expected = safeOrigin(appUrl);
  if (expected === null) return false;

  if (origin) return safeOrigin(origin) === expected;

  // `Referer` carries a full URL; compare only its origin component.
  if (referer) return safeOrigin(referer) === expected;

  return false;
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Sanitise a post-login redirect target.
 *
 * OPEN REDIRECT DEFENCE
 * A `next` parameter that accepts an absolute URL lets an attacker send
 * `/login?next=https://evil.example` and have our own domain bounce a
 * freshly-authenticated user to a convincing credential-harvesting page.
 *
 * Only same-origin RELATIVE paths are accepted. Everything else silently falls
 * back to the default.
 *
 * Rejected forms, and why each matters:
 *   - `https://evil.com`   absolute URL → another origin
 *   - `//evil.com`         protocol-relative → the browser reads this as a host
 *   - `/\evil.com`         backslash → some parsers normalise `\` to `/`
 *   - `javascript:...`     scheme injection
 *   - anything not starting with `/`
 *
 * @param fallback Where to go when the input is absent or rejected.
 */
export function sanitiseRedirect(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next) return fallback;

  // Decode first: an encoded payload such as `%2f%2fevil.com` would otherwise
  // pass the textual checks below and then be decoded by the browser.
  let candidate: string;
  try {
    candidate = decodeURIComponent(next);
  } catch {
    return fallback;
  }

  // Control characters (including CR/LF) enable response-splitting when a
  // value is echoed into a Location header.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;

  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//')) return fallback;
  if (candidate.startsWith('/\\')) return fallback;
  if (candidate.includes('\\')) return fallback;

  return candidate;
}

/**
 * Extract the client IP address for rate limiting.
 *
 * `X-Forwarded-For` is attacker-controlled unless a proxy we control appends
 * it, so it is honoured ONLY when `trustProxy` is set. Trusting it
 * unconditionally would make per-IP rate limiting bypassable with a single
 * header, which is worse than having no per-IP limit at all — it creates the
 * appearance of a control that does not exist.
 *
 * When trusted, the LEFTMOST entry is used: proxies append, so the first entry
 * is the original client. (Where an attacker can inject a leading value, only
 * a known-proxy-count strategy is sound; that is documented as a follow-up in
 * ADR-0009.)
 */
export function extractClientIp(
  headers: { get(name: string): string | null },
  directAddress: string | null,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return first;

    const real = headers.get('x-real-ip')?.trim();
    if (real) return real;
  }

  return directAddress ?? 'unknown';
}

/**
 * Truncate a User-Agent before storage.
 *
 * Stored for the "active sessions" view and incident investigation only.
 * Bounded because it is attacker-controlled and unbounded input in a database
 * column is a denial-of-service vector.
 */
export function normaliseUserAgent(userAgent: string | null | undefined): string | undefined {
  if (!userAgent) return undefined;
  return userAgent.slice(0, 512);
}
