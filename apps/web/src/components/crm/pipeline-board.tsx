'use client';

/**
 * Pipeline Kanban board.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Renders a workspace's pipeline and moves deals between stages.
 *
 * NO OPTIMISTIC LIES (a Stage 2 requirement)
 * A card does NOT move until the server confirms it. The move request goes
 * out, the service validates it, the database commits stage + status +
 * timeline entry in one transaction, and only then does the card settle in its
 * new column. While in flight the card is visibly pending and the board is
 * locked against a second move.
 *
 * The alternative — moving the card immediately and rolling back on failure —
 * needs rollback logic that is correct under concurrent edits, and when it is
 * wrong the user is told a deal moved when it did not. For a surface where the
 * data IS the commercial record, showing the truth slightly later beats showing
 * a comfortable fiction immediately.
 *
 * KEYBOARD-FIRST, NOT DRAG-FIRST
 * Movement is via a per-card stage `<select>`, which is operable by keyboard,
 * screen reader and touch with no custom interaction code. Pointer drag-and-
 * drop is deferred: an accessible DnD implementation needs its own keyboard
 * protocol, live-region announcements and a drop-target model, and a
 * pointer-only version would make the primary sales surface unusable without a
 * mouse. Recorded as follow-up in the Stage 2 development log.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Surface } from '@growth-os/ui';
import type { OpportunityView, PipelineView, StageCategory } from '@growth-os/contracts';

interface PipelineBoardProps {
  readonly pipeline: PipelineView;
  readonly opportunities: readonly OpportunityView[];
  readonly canMove: boolean;
  readonly currency: string;
}

const CATEGORY_ACCENT: Record<StageCategory, string> = {
  open: 'bg-line',
  won: 'bg-signal',
  lost: 'bg-critical',
};

function formatMinor(valueMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(valueMinor / 100);
}

export function PipelineBoard({ pipeline, opportunities, canMove, currency }: PipelineBoardProps) {
  const [deals, setDeals] = useState<readonly OpportunityView[]>(opportunities);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  async function moveDeal(deal: OpportunityView, stageId: string) {
    if (!canMove || movingId) return;

    setMovingId(deal.id);
    setError(null);

    try {
      const response = await fetch(`/api/crm/opportunities/${deal.id}/stage`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          stageId,
          // Optimistic concurrency: if someone else already moved this card,
          // the server returns 409 rather than silently overwriting them.
          expectedCurrentStageId: deal.stageId,
        }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: { message?: string } }).error.message ?? '')
            : '';
        setError(message || 'Could not move this deal.');
        return;
      }

      // Only NOW does the card move — with the server's authoritative row.
      const updated = body as OpportunityView;
      setDeals((existing) => existing.map((item) => (item.id === deal.id ? updated : item)));
      setAnnouncement(`${updated.title} moved to ${updated.stageName}`);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setMovingId(null);
    }
  }

  const totalOpenValue = deals
    .filter((deal) => deal.status === 'open')
    .reduce((sum, deal) => sum + deal.estimatedValueMinor, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-h3 text-text">{pipeline.name}</h2>
          <span className="text-caption text-text-subtle">
            {deals.filter((deal) => deal.status === 'open').length} open ·{' '}
            <span className="font-mono tabular-nums">{formatMinor(totalOpenValue, currency)}</span>
          </span>
        </div>
      </div>

      {/* Stage changes are announced, because for a screen-reader user the
          card silently relocating in the DOM is not perceivable. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {error}
        </p>
      ) : null}

      {/* The board scrolls horizontally inside its own container; the page
          body never scrolls sideways. */}
      <div className="-mx-1 overflow-x-auto pb-2">
        <ol className="flex min-w-max gap-3 px-1">
          {pipeline.stages.map((stage) => {
            const stageDeals = deals.filter((deal) => deal.stageId === stage.id);
            const stageValue = stageDeals.reduce((sum, deal) => sum + deal.estimatedValueMinor, 0);

            return (
              <li key={stage.id} className="w-[268px] shrink-0">
                <section aria-labelledby={`stage-${stage.id}`} className="flex flex-col gap-2">
                  <header className="flex items-center justify-between gap-2 px-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_ACCENT[stage.category]}`}
                      />
                      <h3
                        id={`stage-${stage.id}`}
                        className="truncate text-overline text-text-muted uppercase"
                      >
                        {stage.name}
                      </h3>
                    </div>
                    <span className="shrink-0 font-mono text-caption text-text-subtle tabular-nums">
                      {stageDeals.length}
                    </span>
                  </header>

                  <p className="px-1 font-mono text-caption text-text-subtle tabular-nums">
                    {formatMinor(stageValue, currency)}
                  </p>

                  <ul className="flex flex-col gap-2">
                    {stageDeals.map((deal) => (
                      <li key={deal.id}>
                        <DealCard
                          deal={deal}
                          stages={pipeline.stages}
                          currency={currency}
                          canMove={canMove}
                          pending={movingId === deal.id}
                          disabled={movingId !== null && movingId !== deal.id}
                          onMove={(stageId) => void moveDeal(deal, stageId)}
                        />
                      </li>
                    ))}

                    {stageDeals.length === 0 ? (
                      <li>
                        <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-caption text-text-subtle">
                          Empty
                        </div>
                      </li>
                    ) : null}
                  </ul>
                </section>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  stages,
  currency,
  canMove,
  pending,
  disabled,
  onMove,
}: {
  deal: OpportunityView;
  stages: PipelineView['stages'];
  currency: string;
  canMove: boolean;
  pending: boolean;
  disabled: boolean;
  onMove: (stageId: string) => void;
}) {
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(deal.createdAt).getTime()) / 86_400_000),
  );

  return (
    <Surface
      level={1}
      className={`flex flex-col gap-2 p-3 transition-opacity duration-[120ms] ${
        pending ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-body font-medium text-text">{deal.title}</p>
        <span className="shrink-0 font-mono text-caption text-text tabular-nums">
          {formatMinor(deal.estimatedValueMinor, currency)}
        </span>
      </div>

      <Link
        href={`/customers/contacts/${deal.contactId}`}
        className="truncate text-caption text-text-muted hover:text-signal focus-visible:outline-none"
      >
        {deal.contactName}
      </Link>

      <div className="flex flex-wrap items-center gap-1.5">
        {deal.sourceType ? (
          <Badge tone="neutral">{deal.sourceType.replace(/_/g, ' ')}</Badge>
        ) : null}
        <span className="font-mono text-overline text-text-subtle tabular-nums">{ageDays}d</span>
        {deal.ownerName ? (
          <span className="truncate text-overline text-text-subtle">{deal.ownerName}</span>
        ) : null}
      </div>

      {canMove ? (
        <>
          <label htmlFor={`move-${deal.id}`} className="sr-only">
            Move {deal.title} to a different stage
          </label>
          <select
            id={`move-${deal.id}`}
            value={deal.stageId}
            disabled={disabled || pending}
            onChange={(event) => onMove(event.target.value)}
            className="mt-1 h-8 w-full rounded-sm border border-line bg-surface-2 px-2 text-caption text-text-muted transition-colors duration-[120ms] hover:border-line-strong focus-visible:outline-none disabled:opacity-50"
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </Surface>
  );
}
