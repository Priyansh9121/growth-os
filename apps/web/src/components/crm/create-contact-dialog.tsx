'use client';

/**
 * Create-contact dialog.
 *
 * ACCESSIBILITY — the parts a modal usually gets wrong
 *  - `role="dialog"` + `aria-modal` + `aria-labelledby`
 *  - focus moves INTO the dialog on open and RETURNS to the trigger on close
 *  - focus is trapped: Tab from the last control wraps to the first
 *  - Escape closes it
 *  - the backdrop is inert to screen readers (`aria-hidden`) but clickable
 *
 * Validation uses the SAME `createContactSchema` the server enforces, so the
 * two cannot disagree about what is acceptable. Client validation here is UX;
 * the server re-validates independently and is the authority.
 *
 * The source field is deliberately limited to the values a human can honestly
 * assert. A person adding a contact by hand knows they were a referral or a
 * phone call; they do not know a UTM campaign, and offering the full list
 * would invite invented provenance (ADR-0012).
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Surface } from '@growth-os/ui';
import {
  createContactSchema,
  SOURCE_TYPE_LABELS,
  type ContactView,
  type CreateContactResult,
  type SourceType,
} from '@growth-os/contracts';

/** Sources a human can truthfully declare when typing a contact in by hand. */
const MANUAL_SOURCE_TYPES: readonly SourceType[] = [
  'manual',
  'referral',
  'voice',
  'website_form',
  'google_business_profile',
  'direct',
];

interface CreateContactDialogProps {
  readonly onClose: () => void;
  readonly onCreated: (contact: ContactView) => void;
}

export function CreateContactDialog({ onClose, onCreated }: CreateContactDialogProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('manual');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  /** The element focused before opening, so focus can be restored on close. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();

    return () => {
      // Returning focus is what makes a dialog usable by keyboard: without it
      // the user is dumped at the top of the document on close.
      restoreFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      // Focus trap. Without it, Tab walks out of the dialog into the page
      // behind, which is still visible but not operable.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const candidate = {
      firstName,
      lastName: lastName || undefined,
      email: email || undefined,
      phone: phone || undefined,
      acquisition: {
        sourceType,
        sourcePlatform: 'unknown' as const,
        // A human typing a contact in is `manual` confidence, by definition.
        confidence: 'manual' as const,
      },
    };

    const parsed = createContactSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setFormError(null);
    setPending(true);

    try {
      const response = await fetch('/api/crm/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(parsed.data),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: { message?: string } }).error.message ?? '')
            : '';
        setFormError(message || 'Could not save this contact.');
        return;
      }

      const result = body as CreateContactResult;

      // Deduplication REPORTS; it never merges. The contact is created either
      // way, and the operator is told so they can decide (ADR-0015).
      if (result.duplicateOf) {
        setDuplicateWarning(
          `Heads up — ${result.duplicateOf.displayName} already has this ${result.duplicateOf.matchedOn}.`,
        );
        setTimeout(() => onCreated(result.contact), 1600);
        return;
      }

      onCreated(result.contact);
    } catch {
      setFormError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-canvas/70 backdrop-blur-sm"
      />

      <Surface level={4} className="relative w-full max-w-md p-0">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-contact-title"
          className="p-6"
        >
          <h2 id="create-contact-title" className="text-h2 text-text">
            Add contact
          </h2>
          <p className="mt-1 text-body text-text-muted">
            Only a name and one way to reach them is required.
          </p>

          <div aria-live="assertive" aria-atomic="true">
            {formError ? (
              <p
                role="alert"
                className="mt-4 rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
              >
                {formError}
              </p>
            ) : null}
            {duplicateWarning ? (
              <p
                role="status"
                className="mt-4 rounded-md border border-attention/40 bg-attention-dim/20 px-3.5 py-2.5 text-body text-attention"
              >
                {duplicateWarning}
              </p>
            ) : null}
          </div>

          <form onSubmit={handleSubmit} noValidate className="mt-5 flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                ref={firstFieldRef}
                label="First name"
                required
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                error={errors['firstName']}
                disabled={pending}
                autoComplete="given-name"
              />
              <Field
                label="Last name"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                error={errors['lastName']}
                disabled={pending}
                autoComplete="family-name"
              />
            </div>

            <Field
              label="Email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={errors['email']}
              disabled={pending}
              autoComplete="email"
              placeholder="name@company.com"
            />

            <Field
              label="Phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              error={errors['phone']}
              disabled={pending}
              autoComplete="tel"
              description="Any format — it is normalised for matching."
            />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="contact-source" className="text-caption font-medium text-text-muted">
                How did they reach you?
              </label>
              <select
                id="contact-source"
                value={sourceType}
                disabled={pending}
                onChange={(event) => setSourceType(event.target.value as SourceType)}
                className="h-12 rounded-md border border-line bg-surface-2 px-3.5 text-body-lg text-text transition-colors duration-[120ms] hover:border-line-strong focus-visible:outline-none disabled:opacity-50 sm:text-body"
              >
                {MANUAL_SOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {SOURCE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" loading={pending} loadingLabel="Saving contact">
                Add contact
              </Button>
            </div>
          </form>
        </div>
      </Surface>
    </div>
  );
}
