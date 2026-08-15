'use client';

/**
 * The sign-in form.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Collects credentials, submits them, and drives the transition state machine.
 * It performs no authentication logic of its own — client-side validation here
 * is UX, never a control, and the server re-validates everything.
 *
 * THE CRITICAL LINE IN THIS FILE
 * `router.push()` is called immediately on success, in PARALLEL with
 * `AUTH_SUCCEEDED`. Navigation is never gated on animation: if every line of
 * scene code failed, the user would still arrive at the dashboard,
 * authenticated. Animation observes the machine; it does not control routing.
 *
 * @see docs/design/login-experience.md
 * @see docs/decisions/ADR-0008-login-transition-architecture.md
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, GrowthMark } from '@growth-os/ui';
import { loginInputSchema } from '@growth-os/contracts';
import { useAuthTransition } from '../auth-transition/provider';
import { isBusy } from '../auth-transition/machine';

interface LoginFormProps {
  /** Validated server-side before use; the client copy is a convenience only. */
  readonly next?: string | undefined;
}

interface FieldErrors {
  email?: string;
  password?: string;
}

export function LoginForm({ next }: LoginFormProps) {
  const router = useRouter();
  const { state, dispatch } = useAuthTransition();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const emailRef = useRef<HTMLInputElement>(null);

  const busy = isBusy(state.phase);
  const failed = state.phase === 'auth_failed';

  // Return focus to the form after a failure so a keyboard user can retry
  // immediately, without hunting for the field they were in.
  useEffect(() => {
    if (failed) emailRef.current?.focus();
  }, [failed]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    // Shape validation only — presence and a plausible email. Password policy
    // is deliberately NOT enforced here: rejecting a short password client-side
    // would lock out a user whose password predates the current policy, and
    // would leak the policy to anyone probing the form.
    const parsed = loginInputSchema.safeParse({ email, password, next });

    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'email' && !errors.email) errors.email = issue.message;
        if (field === 'password' && !errors.password) errors.password = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    dispatch({ type: 'SUBMIT' });

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Cookies must be included for the session cookie to be set.
        credentials: 'same-origin',
        body: JSON.stringify(parsed.data),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: { message?: string } }).error.message ?? '')
            : '';

        dispatch({
          type: 'AUTH_FAILED',
          message: message || 'Email or password is incorrect.',
        });
        return;
      }

      const redirectTo =
        typeof body === 'object' && body !== null && 'redirectTo' in body
          ? String((body as { redirectTo: string }).redirectTo)
          : '/dashboard';

      // ---------------------------------------------------------------------
      // Navigation and animation start together and are independent.
      // ---------------------------------------------------------------------
      dispatch({ type: 'AUTH_SUCCEEDED' });
      router.push(redirectTo);
    } catch {
      // Network failure. Deliberately the same generic wording — a distinct
      // "network error" message would tell an attacker probing the endpoint
      // that their request reached the server.
      dispatch({
        type: 'AUTH_FAILED',
        message: 'Something went wrong. Check your connection and try again.',
      });
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-busy={busy} className="flex flex-col gap-5">
      {/* Announced on appearance without stealing focus mid-typing. */}
      <div aria-live="assertive" aria-atomic="true">
        {failed && state.errorMessage ? (
          <p
            role="alert"
            className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
          >
            {state.errorMessage}
          </p>
        ) : null}
      </div>

      <Field
        ref={emailRef}
        label="Email"
        type="email"
        name="email"
        // Lets password managers fill and save credentials, which is a real
        // security control: it is what makes unique per-site passwords viable.
        autoComplete="username"
        inputMode="email"
        autoFocus
        required
        disabled={busy}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={fieldErrors.email}
        placeholder="you@company.com"
      />

      <Field
        label="Password"
        type={passwordVisible ? 'text' : 'password'}
        name="password"
        autoComplete="current-password"
        required
        disabled={busy}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={fieldErrors.password}
        trailing={
          <button
            type="button"
            // A real button with a state-reflecting accessible name — never a
            // bare icon, which announces as nothing.
            aria-pressed={passwordVisible}
            aria-label={passwordVisible ? 'Hide password' : 'Show password'}
            disabled={busy}
            onClick={() => setPasswordVisible((visible) => !visible)}
            className="grid h-10 w-10 place-items-center rounded-sm text-text-subtle transition-colors duration-[120ms] hover:text-text focus-visible:outline-none disabled:opacity-40"
          >
            <EyeIcon open={passwordVisible} />
          </button>
        }
      />

      <Button type="submit" size="lg" fullWidth loading={busy} loadingLabel="Signing in">
        Sign in
      </Button>

      <p className="text-center text-caption text-text-subtle">
        Accounts are created by invitation during Stage 1.
      </p>
    </form>
  );
}

/** Decorative: the surrounding button carries the accessible name. */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      {!open ? (
        <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

/**
 * Success indicator on the card.
 *
 * The mark pulses at the moment authentication succeeds — the first beat of
 * the transition, before the lattice begins converging.
 */
export function LoginSuccessMark() {
  const { state } = useAuthTransition();
  const succeeded =
    state.phase !== 'idle' && state.phase !== 'submitting' && state.phase !== 'auth_failed';

  return (
    <GrowthMark
      size={28}
      pulse={succeeded}
      className={succeeded ? 'text-signal transition-colors duration-[260ms]' : 'text-signal-dim'}
    />
  );
}
