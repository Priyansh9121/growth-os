/**
 * The honeypot field name.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Produce a field name that looks plausible to a bot and is stable for a given
 * form version, without being the same constant on every Growth OS form in the
 * world.
 *
 * WHY NOT A FIXED NAME
 * `name="website"` on every form we ever publish is one pull request away from
 * being in every spam toolkit's skip-list. Deriving it from the version id
 * means each form has its own, and a form that is edited gets a new one.
 *
 * WHY NOT RANDOM PER REQUEST
 * The server has to recognise the field when the submission comes back. A
 * per-request value would need to be signed and round-tripped, which is more
 * machinery than a low-value signal deserves.
 *
 * ⚠️ THIS IS ONE SIGNAL, NEVER THE ONLY ONE. A honeypot catches naive form
 * fillers and nothing else. It is cheap, so it is worth having; it is weak, so
 * nothing depends on it.
 */

import { createHash } from 'node:crypto';

/**
 * Names that look like real fields a bot would want to fill.
 *
 * Deliberately mundane. A field called `honeypot_do_not_fill` is skipped by
 * anything more sophisticated than a `for` loop.
 */
const PLAUSIBLE_NAMES = [
  'website',
  'company_url',
  'fax',
  'address_2',
  'nickname',
  'referrer_name',
  'alt_email',
  'home_page',
] as const;

/**
 * Derive a stable honeypot field name for a form version.
 *
 * Not a secret and not a security boundary — anyone can read the rendered HTML
 * and see which input is hidden. Its only job is to not be the same string
 * across every deployment.
 */
export function honeypotKeyFor(versionId: string): string {
  const digest = createHash('sha256').update(`honeypot:${versionId}`).digest();
  const first = digest[0] ?? 0;
  const name = PLAUSIBLE_NAMES[first % PLAUSIBLE_NAMES.length] ?? 'website';
  // A short suffix so two forms picking the same base name still differ.
  return `${name}_${digest.toString('hex').slice(0, 4)}`;
}
