'use client';

/**
 * The public form renderer.
 *
 * ⚠️ ONE IMPLEMENTATION, THREE SURFACES: the hosted form at `/f/<key>`, the
 * embedded iframe, and the admin preview. There is deliberately no second
 * "preview" component — a preview that renders differently from the real form
 * is worse than no preview, because it builds confidence in something that was
 * never tested.
 *
 * ACCESSIBILITY IS NOT OPTIONAL HERE
 * This is the surface a business's customers use, on a device we did not
 * choose, possibly with a screen reader. Every field has a real `<label for>`;
 * errors carry `role="alert"` and are linked by `aria-describedby`; the invalid
 * state is announced; focus moves to the first error on failure; and nothing
 * depends on animation.
 *
 * MOBILE IS THE PRIMARY CASE
 * Most enquiries are typed on a phone. `type="email"` and `type="tel"` are set
 * so the right keyboard appears, `autocomplete` is set so autofill works, and
 * every control is at least 44px tall.
 *
 * NO `dangerouslySetInnerHTML` ANYWHERE. Labels and help text are workspace
 * configuration, and React escapes them. Introducing raw HTML here would make
 * a form label a stored-XSS vector on a customer's own website.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { PublicFormView, SuccessBehaviour } from '@growth-os/contracts';

interface FormRendererProps {
  readonly form: PublicFormView;
  /** Absent in preview mode, which renders the form but submits nothing. */
  readonly submitUrl?: string;
  readonly preview?: boolean;
}

/** Generate an opaque submission id. Used as the idempotency key. */
function newSubmissionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function FormRenderer({ form, submitUrl, preview = false }: FormRendererProps) {
  const baseId = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [success, setSuccess] = useState<SuccessBehaviour | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  /**
   * The submission id is generated ONCE per form instance, not per attempt.
   *
   * That is what makes a retry a retry. If a click produced a new id, a user
   * double-clicking or a flaky connection retrying would create two leads —
   * the exact duplication the idempotency receipt exists to prevent.
   */
  const submissionId = useRef(newSubmissionId());
  const renderedAt = useRef(Date.now());

  // Reset the id after a SUCCESSFUL submission, so someone legitimately
  // sending a second enquiry is not treated as a duplicate of their first.
  useEffect(() => {
    if (status === 'done') submissionId.current = newSubmissionId();
  }, [status]);

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};

    for (const field of form.fields) {
      const value = values[field.key];
      const text = typeof value === 'string' ? value.trim() : '';

      if (field.required && text.length === 0 && value !== true) {
        found[field.key] = `${field.label} is required.`;
        continue;
      }
      if (text.length === 0) continue;

      // Client-side validation is a COURTESY, not a control — the server
      // validates everything again against the published version. Its job is
      // to save a round trip, so the rules are deliberately loose: a rejected
      // valid address costs a lead, and email addresses are far stranger than
      // most patterns assume.
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        found[field.key] = 'Enter a valid email address.';
      }
    }

    return found;
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (status === 'sending' || preview || !submitUrl) return;

    const found = validate();
    setErrors(found);

    if (Object.keys(found).length > 0) {
      // Focus the first invalid field. Without this a screen-reader user is
      // told something failed and left to hunt for it.
      const firstKey = form.fields.find((field) => found[field.key])?.key;
      if (firstKey) formRef.current?.querySelector<HTMLElement>(`[name="${firstKey}"]`)?.focus();
      return;
    }

    // Disabling submit is UX, NOT concurrency control. The server's
    // idempotency receipt is what actually prevents a duplicate lead.
    setStatus('sending');

    try {
      const attribution = readAttribution();
      const response = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values,
          submissionId: submissionId.current,
          trap: form.honeypotKey ? (values[form.honeypotKey] ?? '') : undefined,
          context: {
            ...attribution,
            submissionPath: window.location.pathname,
            elapsedMs: Date.now() - renderedAt.current,
          },
        }),
      });

      const body: unknown = await response.json().catch(() => null);
      const accepted = readAcceptance(body);

      if (accepted) {
        if (accepted.kind === 'redirect') {
          // The URL was validated as https at CONFIGURATION time by an
          // authenticated admin, and re-validated here before navigating — a
          // redirect target is the one value where trusting the server's
          // response would still be an open-redirect on a customer's site.
          if (isSafeRedirect(accepted.url)) window.location.assign(accepted.url);
          else setStatus('error');
          return;
        }
        setSuccess(accepted);
        setStatus('done');
        return;
      }

      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done' && success?.kind === 'message') {
    return (
      <div
        // `status` rather than `alert`: success is polite, and an assertive
        // announcement interrupts whatever the user was doing.
        role="status"
        className="rounded-lg border border-line bg-surface-1 p-6 text-center"
      >
        <p className="text-body text-text">{success.message}</p>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      className="flex flex-col gap-4"
    >
      {form.fields.map((field) => {
        const fieldId = `${baseId}-${field.key}`;
        const errorId = `${fieldId}-error`;
        const helpId = `${fieldId}-help`;
        const error = errors[field.key];
        const describedBy =
          [field.helpText ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') ||
          undefined;

        return (
          <div key={field.key} className="flex flex-col gap-1.5">
            <label htmlFor={fieldId} className="text-caption font-medium text-text-muted">
              {field.label}
              {field.required ? (
                <>
                  <span aria-hidden="true" className="ml-0.5 text-critical">
                    *
                  </span>
                  <span className="sr-only"> (required)</span>
                </>
              ) : null}
            </label>

            {field.helpText ? (
              <p id={helpId} className="text-caption text-text-subtle">
                {field.helpText}
              </p>
            ) : null}

            <FieldControl
              id={fieldId}
              field={field}
              value={values[field.key]}
              invalid={error !== undefined}
              describedBy={describedBy}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
            />

            {error ? (
              <p id={errorId} role="alert" className="text-caption text-critical">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}

      {/*
        The honeypot. Hidden from sighted users AND from screen readers
        (`aria-hidden` plus `tabIndex={-1}`), so an assistive-technology user is
        never asked to fill a field that would reject their enquiry.
        `autoComplete="off"` stops a password manager filling it.
      */}
      {form.honeypotKey ? (
        <div aria-hidden="true" className="absolute h-0 w-0 overflow-hidden opacity-0">
          <label htmlFor={`${baseId}-trap`}>Leave this blank</label>
          <input
            id={`${baseId}-trap`}
            name={form.honeypotKey}
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={
              typeof values[form.honeypotKey] === 'string' ? String(values[form.honeypotKey]) : ''
            }
            onChange={(event) =>
              setValues((current) => ({ ...current, [form.honeypotKey!]: event.target.value }))
            }
          />
        </div>
      ) : null}

      {status === 'error' ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {/* The server does not say why, on purpose. The message is written
              for a real person who just lost their typing, not for a bot. */}
          Sorry — we could not send that. Please check your details and try again.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={status === 'sending' || preview}
        // 44px minimum touch target. Most enquiries are typed on a phone.
        className="inline-flex h-11 items-center justify-center rounded-md bg-signal px-5 text-body font-medium text-canvas transition-opacity duration-[120ms] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-60"
      >
        {status === 'sending' ? 'Sending…' : form.submitLabel}
      </button>

      {preview ? (
        <p className="text-center text-caption text-text-subtle">
          Preview — this form does not submit.
        </p>
      ) : null}
    </form>
  );
}

const CONTROL =
  'w-full rounded-md border bg-surface-2 px-3 text-body text-text transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal';

function FieldControl({
  id,
  field,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  field: PublicFormView['fields'][number];
  value: string | boolean | undefined;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const border = invalid ? 'border-critical' : 'border-line hover:border-line-strong';
  const shared = {
    id,
    name: field.key,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    required: field.required,
    maxLength: field.maxLength,
  };

  if (field.type === 'textarea') {
    return (
      <textarea
        {...shared}
        rows={4}
        placeholder={field.placeholder ?? undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} ${border} py-2.5`}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <select
        {...shared}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} ${border} h-11`}
      >
        <option value="">Choose…</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <input
        {...shared}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5 accent-signal"
      />
    );
  }

  return (
    <input
      {...shared}
      // The right virtual keyboard, and autofill that works. Both matter more
      // on this surface than anywhere else in the product.
      type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
      inputMode={field.type === 'phone' ? 'tel' : field.type === 'email' ? 'email' : undefined}
      autoComplete={autocompleteFor(field.key, field.type)}
      placeholder={field.placeholder ?? undefined}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL} ${border} h-11`}
    />
  );
}

/**
 * Map a field to an `autocomplete` token.
 *
 * Autofill is an accessibility feature as much as a convenience — for someone
 * with a motor impairment it can be the difference between a form taking ten
 * seconds and two minutes.
 */
function autocompleteFor(key: string, type: string): string | undefined {
  if (type === 'email') return 'email';
  if (type === 'phone') return 'tel';
  if (/first|given/i.test(key)) return 'given-name';
  if (/last|family|surname/i.test(key)) return 'family-name';
  if (/company|business|organisation/i.test(key)) return 'organization';
  return undefined;
}

/**
 * Narrow an unknown response body to an acceptance.
 *
 * Written as a guard rather than a cast: the response crosses an origin
 * boundary, and a cast would let a malformed or hostile body through into
 * `window.location.assign`.
 */
function readAcceptance(body: unknown): SuccessBehaviour | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; success?: unknown };
  if (envelope.ok !== true) return null;

  const success = envelope.success;
  if (typeof success !== 'object' || success === null) return null;

  const shape = success as { kind?: unknown; message?: unknown; url?: unknown };
  if (shape.kind === 'message' && typeof shape.message === 'string') {
    return { kind: 'message', message: shape.message };
  }
  if (shape.kind === 'redirect' && typeof shape.url === 'string') {
    return { kind: 'redirect', url: shape.url };
  }
  return null;
}

/**
 * Re-check a redirect target before navigating.
 *
 * Belt and braces: the URL was validated as `https:` when an authenticated
 * admin configured it, and is validated again here. A form that could be made
 * to navigate to `javascript:` would be an XSS primitive published on a
 * customer's website.
 */
function isSafeRedirect(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const ATTRIBUTION_KEYS = [
  'landingPath',
  'referrerOrigin',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmTerm',
  'utmContent',
  'gclid',
  'fbclid',
  'sessionId',
] as const;

/**
 * Read attribution, preferring a stored FIRST TOUCH over this page's own URL.
 *
 * TWO SOURCES, IN THAT ORDER, AND THE ORDER IS THE POINT.
 *
 *  1. `sessionStorage`, written by the tracking script on the customer's site.
 *     A visitor who landed on `/emergency-plumber?utm_campaign=…` and reached
 *     the form on `/contact` is attributed to the campaign — first touch wins.
 *
 *  2. Failing that, THIS PAGE'S OWN URL. The hosted form at `/f/<key>` is
 *     shared directly in email campaigns, QR codes and ad landing links, where
 *     the form page IS the landing page. Without this, every one of those
 *     visits was recorded as `direct` and the campaign that paid for it was
 *     invisible — which an end-to-end test caught after the classifier,
 *     ingestion and CRM had all behaved perfectly on data that never arrived.
 *
 * Returns `{}` when neither yields anything. **The form works regardless**: a
 * business must never lose an enquiry because a visitor declined tracking
 * (ADR-0028 §5).
 */
function readAttribution(): Record<string, string> {
  const stored = readStoredAttribution();
  // A stored first touch is never overwritten by the current page.
  if (Object.keys(stored).length > 0) return stored;
  return readUrlAttribution();
}

function readStoredAttribution(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem('growth-os.attribution');
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};

    const source = parsed as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of ATTRIBUTION_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.length > 0) result[key] = value;
    }
    return result;
  } catch {
    // Blocked, disabled, private mode, quota, or corrupt JSON. Fall through to
    // the URL rather than failing — attribution is best-effort, always.
    return {};
  }
}

/**
 * Derive attribution from the current URL.
 *
 * Applies the SAME privacy rules as the tracking script, because the server
 * cannot tell which one produced a value: the path is stored without its query
 * string, and the referrer is reduced to an origin — both because query strings
 * routinely carry personal data (ADR-0028 §3).
 */
function readUrlAttribution(): Record<string, string> {
  try {
    const params = new URLSearchParams(window.location.search);
    const result: Record<string, string> = {
      // PATH only. The parameters below are read individually; the rest of the
      // query string is discarded rather than stored.
      landingPath: window.location.pathname.slice(0, 512),
    };

    for (const [param, key] of [
      ['utm_source', 'utmSource'],
      ['utm_medium', 'utmMedium'],
      ['utm_campaign', 'utmCampaign'],
      ['utm_term', 'utmTerm'],
      ['utm_content', 'utmContent'],
      ['gclid', 'gclid'],
      ['fbclid', 'fbclid'],
    ] as const) {
      const value = params.get(param);
      if (value) result[key] = value.slice(0, 255);
    }

    if (document.referrer) {
      const referrer = new URL(document.referrer);
      // ORIGIN only — a Google referrer's `?q=` is discarded here, and a
      // referrer from our own origin is a navigation, not an acquisition.
      if (referrer.origin !== window.location.origin) result['referrerOrigin'] = referrer.origin;
    }

    return result;
  } catch {
    return {};
  }
}
