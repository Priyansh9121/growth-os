'use client';

/**
 * The two password-reset forms.
 *
 * BOTH ARE WRITTEN TO REVEAL NOTHING.
 *
 * `RequestResetForm` shows the same confirmation for a known address as for
 * an unknown one, because the server deliberately answers the same way. The
 * wording is chosen carefully: "if an account exists" is honest, and does not
 * promise an email that may never arrive.
 *
 * `SetNewPasswordForm` shows one message for invalid, expired and used tokens,
 * because distinguishing them would confirm which tokens were once real.
 *
 * Neither form auto-signs-in on success. A reset link proves control of an
 * inbox; signing in should prove knowledge of the password just set.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field } from '@growth-os/ui';

function readErrorMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('error' in body)) return '';
  const envelope = (body as { error?: { message?: unknown } }).error;
  return typeof envelope?.message === 'string' ? envelope.message : '';
}

export function RequestResetForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setError(readErrorMessage(body) || 'Something went wrong. Try again shortly.');
        return;
      }

      setSent(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4" role="status">
        <p className="text-body text-text">
          If an account exists for <span className="font-medium">{email}</span>, a reset link is on
          its way. It expires in an hour.
        </p>
        {/* "If an account exists" is not hedging for its own sake — the server
            genuinely does not tell us, because saying so would let anyone
            enumerate the product's customers one address at a time. */}
        <p className="text-caption text-text-subtle">
          Nothing arrived? Check the address, and your spam folder.
        </p>
        <Link href="/login" className="text-body text-signal hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      <Field
        label="Email address"
        type="email"
        name="email"
        value={email}
        autoComplete="email"
        autoFocus
        required
        onChange={(event) => setEmail(event.target.value)}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" loading={busy} fullWidth>
        Send a reset link
      </Button>

      <Link href="/login" className="text-caption text-text-muted hover:text-text">
        Back to sign in
      </Link>
    </form>
  );
}

export function SetNewPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    // Checked here only. The server does not receive the confirmation field at
    // all — a mismatch is a typo, not a security condition, and sending a
    // second copy of the password would put it in one more place.
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/password-reset?action=complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token, password }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setError(readErrorMessage(body) || 'That reset link is no longer valid.');
        return;
      }

      setDone(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4" role="status">
        <p className="text-body text-text">
          Your password has been changed. Every device that was signed in has been signed out.
        </p>
        <Button onClick={() => router.push('/login')} fullWidth>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      <Field
        label="New password"
        type="password"
        name="password"
        value={password}
        autoComplete="new-password"
        autoFocus
        required
        description="At least 12 characters."
        onChange={(event) => setPassword(event.target.value)}
      />

      <Field
        label="Confirm new password"
        type="password"
        name="confirm"
        value={confirm}
        autoComplete="new-password"
        required
        onChange={(event) => setConfirm(event.target.value)}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" loading={busy} fullWidth>
        Set new password
      </Button>
    </form>
  );
}
