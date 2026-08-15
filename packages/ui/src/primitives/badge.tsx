import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Small status label.
 *
 * The `fixture` tone exists specifically to satisfy Principle 3 ("never
 * fabricate a number"): any demo value rendered in the product must carry a
 * visible marker. It is deliberately the loudest tone in the set.
 */
export type BadgeTone = 'neutral' | 'signal' | 'attention' | 'critical' | 'fixture';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-text-muted border-line',
  signal: 'bg-signal-faint text-signal border-signal-dim',
  attention: 'bg-attention-dim/20 text-attention border-attention-dim',
  critical: 'bg-critical-dim/20 text-critical border-critical-dim',
  fixture: 'bg-attention-dim/25 text-attention border-attention/50 font-semibold',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5',
        'text-overline uppercase',
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    />
  );
}
