/**
 * Validation schemas for the authentication boundary.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * These schemas are the contract between the browser and the server. The same
 * definitions drive client-side form validation and server-side enforcement,
 * so the two cannot drift — but note that client validation is UX only. The
 * server parses every request independently and trusts nothing it was sent.
 *
 * @see docs/decisions/ADR-0010-validation-and-contracts.md
 */

import { z } from 'zod';

/**
 * Maximum accepted password length.
 *
 * This is a denial-of-service control, not a security policy. Argon2id is
 * deliberately expensive; without a cap, an attacker could submit a megabyte
 * password and force the server to hash it. 200 characters is far beyond any
 * legitimate passphrase.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Minimum password length.
 *
 * Length is the only requirement. NIST SP 800-63B recommends against composition
 * rules (one upper, one digit, one symbol) because they push users toward
 * predictable patterns like `Password1!` while adding little entropy. Length
 * plus a breached-password check is strictly better; the breach check is
 * planned for Stage 2 alongside registration.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Email normalisation: trim and lowercase.
 *
 * Applied identically at registration and at sign-in so that a user who types
 * `Sam@Example.com` matches the stored `sam@example.com`. Doing this in the
 * schema rather than at each call site guarantees both paths agree — a mismatch
 * here presents as "correct password rejected", which is very hard to diagnose.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required.')
  .max(254, 'Email is too long.')
  .email('Enter a valid email address.');

/**
 * Sign-in input.
 *
 * The password is checked for presence and a sane maximum only. Enforcing the
 * minimum length here would reject a legacy password shorter than the current
 * policy, locking out an existing user — and would leak the policy to an
 * attacker probing the endpoint.
 */
export const loginInputSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(1, 'Password is required.')
    .max(MAX_PASSWORD_LENGTH, 'Password is too long.'),
  /**
   * Where to send the user after signing in. Validated for shape here; the
   * open-redirect check (same-origin, relative path only) happens server-side
   * in `@growth-os/auth`, because a client-side check is not a control.
   */
  next: z.string().max(2048).optional(),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

/** Password rules applied when a password is being *set* (Stage 2). */
export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, 'Password is too long.');

export const registerInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  email: emailSchema,
  password: newPasswordSchema,
  workspaceName: z.string().trim().min(1, 'Business name is required.').max(120),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;

/** Response body for a successful sign-in. Carries no token — the session lives in an httpOnly cookie. */
export const loginResponseSchema = z.object({
  ok: z.literal(true),
  redirectTo: z.string(),
  user: z.object({
    userId: z.string(),
    email: z.string(),
    name: z.string(),
  }),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Request to change the active workspace. */
export const switchWorkspaceInputSchema = z.object({
  workspaceId: z.uuid('Invalid workspace identifier.'),
});

export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceInputSchema>;
