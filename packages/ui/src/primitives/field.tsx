'use client';

/**
 * Labelled form field with accessible error handling.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Owns the wiring between a label, an input, its description and its error —
 * the part of form accessibility that is easy to get subtly wrong and that
 * every form would otherwise re-implement slightly differently.
 *
 * WHAT IT GUARANTEES
 *  - A real `<label for>`. A placeholder is NEVER the only label: placeholders
 *    disappear on input, are frequently skipped by screen readers, and fail
 *    contrast in most implementations.
 *  - `aria-describedby` links the input to its description AND its error, so
 *    both are announced when the field receives focus.
 *  - `aria-invalid` marks the field for assistive technology.
 *  - The error carries `role="alert"`, so it is announced when it appears
 *    without stealing focus from someone mid-typing.
 *  - IDs are generated with `useId`, so multiple instances never collide.
 *
 * @see docs/design/login-experience.md §7 Accessibility
 */

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'size'> {
  readonly label: string;
  /** Static helper text, announced alongside the label. */
  readonly description?: string;
  /** When present the field renders as invalid and announces this message. */
  readonly error?: string | undefined;
  /** Rendered inside the input's right edge — e.g. a password reveal toggle. */
  readonly trailing?: ReactNode;
  readonly containerClassName?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, description, error, trailing, className, containerClassName, required, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = `field-${reactId}`;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;

  // Only reference IDs that are actually rendered. A dangling aria-describedby
  // is announced as nothing by some screen readers and as an error by others.
  const describedBy =
    [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', containerClassName)}>
      <label htmlFor={inputId} className="text-caption font-medium text-text-muted">
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-0.5 text-critical">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>

      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full rounded-md border bg-surface-2 text-text',
            'h-12 px-3.5',
            // 16px on mobile: below that, iOS Safari zooms the viewport on
            // focus, which is disorienting and hard to recover from.
            'text-body-lg sm:text-body',
            'placeholder:text-text-subtle',
            'transition-[border-color,background-color] duration-[120ms] ease-standard',
            'hover:border-line-strong',
            'focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error ? 'border-critical' : 'border-line',
            trailing ? 'pr-12' : '',
            className,
          )}
          {...rest}
        />
        {trailing ? (
          <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>
        ) : null}
      </div>

      {description ? (
        <p id={descriptionId} className="text-caption text-text-subtle">
          {description}
        </p>
      ) : null}

      {error ? (
        // role="alert" announces on appearance without moving focus.
        <p id={errorId} role="alert" className="text-caption text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
});
