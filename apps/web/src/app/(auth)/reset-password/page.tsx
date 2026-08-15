/**
 * Set a new password from a reset link.
 *
 * The token's validity is checked SERVER-SIDE before the form renders, so
 * someone following a stale link is told immediately rather than after typing
 * a password twice.
 *
 * The check returns a boolean and nothing else. An endpoint that returned the
 * account's email address would turn a leaked or forwarded link into a
 * disclosure on its own.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { isResetTokenValid } from '@growth-os/auth';
import { GrowthMark } from '@growth-os/ui';
import { getDependencies } from '../../../server/dependencies';
import { SetNewPasswordForm } from '../../../features/login/password-reset-forms';

export const metadata: Metadata = { title: 'Set a new password' };
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const deps = getDependencies();

  const valid =
    typeof token === 'string' && token.length > 0
      ? await isResetTokenValid(deps.db, token, deps.sessionConfig.secret)
      : false;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6">
      <div className="flex items-center gap-2.5">
        <GrowthMark size={22} className="text-signal" />
        <span className="text-body font-semibold tracking-tight">Growth OS</span>
      </div>

      {valid && token ? (
        <>
          <div>
            <h1 className="text-h1 tracking-tight text-text">Set a new password</h1>
            <p className="mt-2 text-body text-text-muted">
              Choosing a new password signs out every device that was signed in.
            </p>
          </div>
          <SetNewPasswordForm token={token} />
        </>
      ) : (
        <>
          <div>
            <h1 className="text-h1 tracking-tight text-text">This link has expired</h1>
            {/* One message for expired, already-used and never-valid. Telling
                them apart would confirm which tokens were once real. */}
            <p className="mt-2 text-body text-text-muted">
              Reset links last an hour and can only be used once. Request a new one.
            </p>
          </div>
          <Link
            href="/forgot-password"
            className="inline-flex h-10 items-center justify-center rounded-md bg-signal px-4 text-body font-medium text-canvas"
          >
            Request a new link
          </Link>
        </>
      )}
    </main>
  );
}
