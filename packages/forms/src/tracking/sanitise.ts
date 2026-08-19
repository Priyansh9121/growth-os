/**
 * Sanitising attribution context.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Everything in a `SubmissionContext` arrives from a browser and is therefore
 * untrusted — not just as a security matter, but as a data-quality one. This
 * is the last point before those values become a permanent provenance record.
 *
 * TWO DEFENCES, AND THE SECOND IS THE ONE PEOPLE FORGET
 *
 *  1. **Bounds.** A hostile client can send a 400 KB `utm_campaign`. Field caps
 *     exist in the schema; this trims rather than rejects, because a truncated
 *     campaign name is still useful attribution and a rejected submission is a
 *     lost lead.
 *
 *  2. **Truncation to path and origin.** The tracking script already stores
 *     only a path and an origin, but a submission can be posted by anything —
 *     `curl`, a custom integration, a modified page. So the server truncates
 *     again rather than trusting that the client did.
 *
 *     ⚠️ THIS IS A PII CONTROL, NOT TIDINESS. Query strings routinely carry
 *     personal data: a booking confirmation link, an email tracking parameter,
 *     a password reset token someone pasted into a browser. A full landing URL
 *     stored on an acquisition would be PII in a column nobody classifies as
 *     PII, sitting outside erasure's model of where personal data lives.
 *
 * @see docs/decisions/ADR-0028-attribution-storage.md
 * @see docs/security/attribution-privacy.md
 */

import { httpUrlOf, landingPathOf, type SubmissionContext } from '@growth-os/contracts';

const MAX_PATH = 512;
const MAX_PARAM = 255;

/**
 * Reduce anything URL-ish to a bare path.
 *
 * `/emergency-plumber?utm_source=google&email=sarah@x.test` → `/emergency-plumber`
 *
 * A value that is not shaped like a landing path becomes `undefined` rather
 * than being stored as-is: an unparseable "path" is not a path, and keeping it
 * would defeat the whole point of this function.
 *
 * ⚠️ THE SHAPE CHECK LIVES IN `landingPathOf`, NOT HERE, AND THAT IS THE FIX.
 *
 * This used to call `new URL()` directly and trust it to throw. It does not
 * throw — it **resolves** almost any string against the base. Measured over 13
 * inputs (dev log 0024, re-measured in 0025), this function and
 * `splitLandingUrl` disagreed about 7, and this one was the permissive side:
 * `::::` was stored as `/::::`, `javascript:alert(1)` as `alert(1)`,
 * `mailto:a@b.test` as `a@b.test`. Every one landed in
 * `acquisitions.landing_path`.
 *
 * There is now one definition of the question and two callers of it
 * (ADR-0044). A property test asserts they still agree.
 *
 * ⚠️ A REFUSAL MUST NOT FAIL THE SUBMISSION. `undefined` means
 * `sanitiseContext` omits the field and the acquisition is written without a
 * landing path — a malformed referrer is ordinary traffic, not an error.
 */
export function toPath(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const path = landingPathOf(value);
  if (path === null) return undefined;

  // A bare `/` carries no attribution value, but it is still the honest answer
  // for a visitor who landed on the home page.
  return path.slice(0, MAX_PATH);
}

/**
 * Reduce a referrer to a bare origin.
 *
 * `https://www.google.com/search?q=emergency+plumber+melbourne` →
 * `https://www.google.com`
 *
 * ⚠️ Note precisely what is discarded there: **the search query**. It arrives
 * in a Google referrer only in rare legacy cases, and the product must not
 * capture it opportunistically — a `search_query` that appears for 2% of
 * visitors would make the keyword report a biased sample presented as data.
 * `searchQuery` is set from Search Console and nothing else (ADR-0012).
 */
export function toOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === 'null') return undefined;

  const url = httpUrlOf(trimmed);
  if (url === null) return undefined;

  return url.origin.slice(0, MAX_PARAM);
}

/** Trim a campaign parameter to a bounded, single-line value. */
function toParam(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Newlines and control characters are stripped: a UTM value carrying a
  // newline is either a bug or an attempt at log injection, and neither is
  // worth preserving.
  // `no-control-regex` is disabled deliberately — matching control characters
  // is the entire purpose of this expression, and the rule exists to catch
  // them appearing by accident.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, MAX_PARAM) : undefined;
}

/**
 * Sanitise a whole submission context.
 *
 * Every field is passed through the appropriate reducer. Building the result
 * key-by-key rather than spreading the input means a field added to the schema
 * is NOT silently carried through unsanitised — it has to be added here.
 */
export function sanitiseContext(context: SubmissionContext): SubmissionContext {
  const result: Record<string, string | number> = {};

  const landingPath = toPath(context.landingPath);
  if (landingPath) result['landingPath'] = landingPath;

  const submissionPath = toPath(context.submissionPath);
  if (submissionPath) result['submissionPath'] = submissionPath;

  const referrerOrigin = toOrigin(context.referrerOrigin);
  if (referrerOrigin) result['referrerOrigin'] = referrerOrigin;

  for (const key of [
    'utmSource',
    'utmMedium',
    'utmCampaign',
    'utmTerm',
    'utmContent',
    'gclid',
    'fbclid',
  ] as const) {
    const value = toParam(context[key]);
    if (value) result[key] = value;
  }

  // The session id is opaque and generated in the browser; bound it and strip
  // anything that is not plausibly an identifier.
  if (context.sessionId) {
    const sessionId = context.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (sessionId.length > 0) result['sessionId'] = sessionId;
  }

  if (typeof context.elapsedMs === 'number' && Number.isFinite(context.elapsedMs)) {
    result['elapsedMs'] = Math.max(0, Math.min(86_400_000, Math.round(context.elapsedMs)));
  }

  return result as SubmissionContext;
}
