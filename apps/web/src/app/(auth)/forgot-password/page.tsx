/**
 * Request a password reset link.
 *
 * A plain page rather than the flagship login treatment. Someone here is
 * locked out and mildly frustrated; the 3D lattice would be an obstacle
 * between them and the one field they need.
 */

import type { Metadata } from 'next';
import { GrowthMark } from '@growth-os/ui';
import { RequestResetForm } from '../../../features/login/password-reset-forms';

export const metadata: Metadata = { title: 'Reset your password' };
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6">
      <div className="flex items-center gap-2.5">
        <GrowthMark size={22} className="text-signal" />
        <span className="text-body font-semibold tracking-tight">Growth OS</span>
      </div>

      <div>
        <h1 className="text-h1 tracking-tight text-text">Reset your password</h1>
        <p className="mt-2 text-body text-text-muted">
          Enter the email address you sign in with and we’ll send you a link.
        </p>
      </div>

      <RequestResetForm />
    </main>
  );
}
