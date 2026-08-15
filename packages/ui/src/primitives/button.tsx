'use client';

/**
 * Button primitive.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The only button in Growth OS. Every interaction state defined in the design
 * system is implemented here so that no screen has to reimplement them.
 *
 * TWO DETAILS THAT MATTER MORE THAN THEY LOOK
 *
 * 1. LOADING PRESERVES WIDTH. The label stays in the DOM at `opacity-0` with
 *    the spinner absolutely positioned over it. Replacing the label outright
 *    would shrink the button mid-click, which moves the thing under the user's
 *    cursor at the exact moment they are looking at it.
 *
 * 2. LOADING IS NOT `disabled`. A `disabled` button is removed from the
 *    accessibility tree and loses focus, so a screen-reader user is dropped to
 *    the top of the document mid-submit. `aria-disabled` + `aria-busy` keeps it
 *    focusable and announced while still refusing activation.
 *
 * @see docs/design/design-system.md §7 Interaction states
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // The accent's only use as a fill. Text is `text-inverse` because the signal
  // green is light — white-on-signal would fail contrast.
  primary:
    'bg-signal text-text-inverse hover:bg-signal-strong active:bg-signal ' +
    'shadow-sm font-medium',
  secondary:
    'bg-surface-2 text-text border border-line hover:border-line-strong hover:bg-surface-3',
  ghost: 'bg-transparent text-text-muted hover:bg-surface-2 hover:text-text',
  danger: 'bg-critical text-text border border-critical hover:brightness-110',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-caption gap-1.5 rounded-sm',
  md: 'h-10 px-4 text-body gap-2 rounded-md',
  // 48px: comfortably above the 44px touch-target minimum, and the height the
  // login form uses so mobile Safari does not zoom on focus.
  lg: 'h-12 px-6 text-body-lg gap-2 rounded-md',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  /** Accessible name while loading. Announced in place of the label. */
  readonly loadingLabel?: string;
  readonly fullWidth?: boolean;
  readonly children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    loadingLabel = 'Loading',
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    onClick,
    ...rest
  },
  ref,
) {
  const inert = loading || disabled === true;

  return (
    <button
      ref={ref}
      type={type}
      // Genuinely disabled only when the caller says so. Loading uses
      // aria-disabled to stay focusable — see the header note.
      disabled={disabled}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      aria-label={loading ? loadingLabel : undefined}
      onClick={(event) => {
        // aria-disabled does not block activation, so it is enforced here.
        if (inert) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(
        'relative inline-flex items-center justify-center whitespace-nowrap',
        'transition-[background-color,border-color,color,transform] duration-[120ms] ease-standard',
        'active:scale-[0.985] active:duration-[80ms]',
        // Focus is never animated: delaying focus feedback is an a11y failure.
        'focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'aria-disabled:cursor-not-allowed',
        !loading && 'aria-disabled:opacity-45',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {/* Label stays mounted so the button cannot change width mid-submit. */}
      <span
        className={cn('inline-flex items-center gap-2', loading && 'opacity-0')}
        aria-hidden={loading}
      >
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={size === 'sm' ? 14 : 16} />
        </span>
      ) : null}
    </button>
  );
});
