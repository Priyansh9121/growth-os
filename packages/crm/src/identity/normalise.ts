/**
 * Contact identity normalisation.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Produces the matching keys (`emailNormalised`, `phoneE164`) that
 * deduplication relies on. Every ingestion path — forms, calls, voice AI,
 * imports, the API, manual entry — passes through this module, so all of them
 * agree on what "the same person" means.
 *
 * If create-time and search-time normalisation ever diverged, a contact would
 * become unfindable by the very identifier they were created with. One shared
 * module, used by both, is the only reliable way to prevent that.
 *
 * @see docs/decisions/ADR-0015-contact-identity-and-deduplication.md
 */

import { httpUrlOf } from '@growth-os/contracts';
import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';

/**
 * Normalise an email for matching.
 *
 * Trim and lowercase. **Nothing else.**
 *
 * Deliberately NOT done: stripping dots, stripping `+aliases`, or any other
 * provider-specific rewriting. Those are Gmail's rules.
 * `first.last@company.com` and `firstlast@company.com` are the same Gmail
 * mailbox but *different addresses* at most other providers, and
 * `sarah+plumbing@example.com` may be a deliberately distinct contact route.
 * Applying Gmail's rules universally silently merges different people, and a
 * wrong merge is not reversible.
 */
export function normaliseEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalised = email.trim().toLowerCase();
  return normalised.length > 0 ? normalised : null;
}

/**
 * Normalise a phone number to E.164 for matching.
 *
 * Returns `null` when the input cannot be parsed with confidence. **Never a
 * mangled guess** — a half-normalised number is worse than none, because it
 * silently fails to match the same person's real number while looking valid.
 *
 * The raw value is always retained separately by the caller, so a number that
 * fails today can be re-normalised later if the region setting is corrected.
 *
 * @param region ISO 3166-1 alpha-2 from `workspaces.default_phone_region`.
 *   `0412 345 678` is a valid mobile in Australia and a valid landline
 *   elsewhere; a global constant would corrupt every non-matching workspace.
 */
export function normalisePhone(phone: string | null | undefined, region: string): string | null {
  if (!phone) return null;

  const trimmed = phone.trim();
  if (trimmed.length < 4) return null;

  try {
    const parsed = parsePhoneNumberWithError(trimmed, region.toUpperCase() as CountryCode);
    // `isValid()` rather than `isPossible()`: possible-but-invalid numbers
    // produce false matches between different people, which is the failure
    // this key exists to prevent.
    return parsed.isValid() ? parsed.number : null;
  } catch {
    // libphonenumber throws on malformed input and unknown regions. A bad
    // phone number must never fail an acquisition — it just does not match.
    return null;
  }
}

/**
 * Normalise a website to a bare hostname.
 *
 * Used as a weak identity signal for companies. Lowercased, `www.` stripped,
 * so `https://www.ABCPlumbing.test/contact` and `abcplumbing.test` agree.
 */
export function normaliseWebsiteHost(website: string | null | undefined): string | null {
  if (!website) return null;

  const url = httpUrlOf(website);
  if (url === null) return null;

  const host = url.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Build the display name from the stored parts.
 *
 * Centralised so the list, the detail page, the timeline and AI tool output
 * cannot disagree about what a contact is called.
 */
export function displayName(firstName: string, lastName: string | null): string {
  return lastName ? `${firstName} ${lastName}` : firstName;
}
