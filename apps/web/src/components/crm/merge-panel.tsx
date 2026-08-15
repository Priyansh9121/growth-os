'use client';

/**
 * Contact merge — the preview-and-confirm surface.
 *
 * THIS SCREEN IS THE SAFETY MODEL
 * There is no unmerge (ADR-0019 §1). The only protection an operator has is
 * seeing the exact blast radius before they act, so this component's job is
 * not to be quick — it is to be unambiguous:
 *
 *   - the survivor and the duplicate are labelled in plain words, not by id
 *   - every row that will move is counted before anything moves
 *   - fields where both records disagree are shown side by side and must be
 *     chosen explicitly; the survivor wins if the operator does nothing
 *   - fields the duplicate fills in are shown separately as gains, because
 *     they need no decision
 *   - the button says what it does and cannot be reached without a preview
 *
 * Nothing here is optimistic. The merge is a single server round trip and the
 * page navigates only after it returns.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Surface } from '@growth-os/ui';
import type { MergeableField, MergePreview } from '@growth-os/contracts';
import { readErrorMessage } from './contact-tags';

interface MergePanelProps {
  readonly survivorId: string;
  readonly candidates: readonly {
    id: string;
    displayName: string;
    email: string | null;
    phone: string | null;
    createdAt: string;
  }[];
}

type Choice = 'survivor' | 'duplicate';

export function MergePanel({ survivorId, candidates }: MergePanelProps) {
  const router = useRouter();
  const [duplicateId, setDuplicateId] = useState(candidates[0]?.id ?? '');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Partial<Record<MergeableField, Choice>>>({});
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (duplicateId === '') {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setChoices({});

    void fetch(
      `/api/crm/contacts/${survivorId}/merge?duplicateId=${encodeURIComponent(duplicateId)}`,
      { credentials: 'same-origin' },
    )
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setError(readErrorMessage(body) || 'Could not load the preview.');
          setPreview(null);
          return;
        }
        setPreview(body as MergePreview);
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach the server.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [survivorId, duplicateId]);

  async function merge(): Promise<void> {
    if (!preview || preview.blockers.length > 0 || merging) return;

    setMerging(true);
    setError(null);

    try {
      const response = await fetch(`/api/crm/contacts/${survivorId}/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          duplicateId,
          fieldChoices: choices,
          // Explicit intent. A request that merely named two ids must not be
          // enough to trigger something with no undo.
          confirm: true,
        }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readErrorMessage(body) || 'The merge did not complete.');
        return;
      }

      router.push(`/customers/contacts/${survivorId}`);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setMerging(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <Surface level={1} className="p-5">
        <p className="text-body text-text-muted">
          No other contact in this workspace shares this person’s email address or phone number.
        </p>
        <p className="mt-2 text-caption text-text-subtle">
          Candidates are matched on exact email or phone only. Names are never used — two people
          called James Carter are two people.
        </p>
      </Surface>
    );
  }

  const totalMoves = preview
    ? Object.values(preview.moves).reduce((sum, count) => sum + count, 0)
    : 0;

  return (
    <div className="flex flex-col gap-5">
      <Surface level={1} className="flex flex-col gap-3 p-5">
        <label htmlFor="merge-duplicate" className="text-caption font-medium text-text-muted">
          Record to merge in
        </label>
        <select
          id="merge-duplicate"
          value={duplicateId}
          onChange={(event) => setDuplicateId(event.target.value)}
          className="h-9 rounded-sm border border-line bg-surface-2 px-2 text-body text-text hover:border-line-strong focus-visible:outline-none"
        >
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.displayName} · {candidate.email ?? candidate.phone ?? 'no contact detail'}{' '}
              · added {new Date(candidate.createdAt).toLocaleDateString('en-AU')}
            </option>
          ))}
        </select>
        <p className="text-caption text-text-subtle">
          Its records move onto this contact, and it becomes a redirect. Links to it keep working.
        </p>
      </Surface>

      {loading ? <p className="text-body text-text-muted">Working out what would change…</p> : null}

      {preview && preview.blockers.length > 0 ? (
        <Surface level={1} className="border-critical/40 bg-critical-dim/10 p-5">
          <h2 className="text-body font-medium text-critical">This merge cannot proceed</h2>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-body text-text-muted">
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Surface>
      ) : null}

      {preview && preview.blockers.length === 0 ? (
        <>
          <section aria-labelledby="moves-heading" className="flex flex-col gap-3">
            <h2 id="moves-heading" className="text-overline text-text-subtle uppercase">
              What moves ({totalMoves} {totalMoves === 1 ? 'record' : 'records'})
            </h2>
            <Surface level={1} className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
              <Count label="Enquiries" value={preview.moves.acquisitions} />
              <Count label="Deals" value={preview.moves.opportunities} />
              <Count label="Tasks" value={preview.moves.tasks} />
              <Count label="Timeline entries" value={preview.moves.activities} />
              <Count label="Tags" value={preview.moves.tags} />
              <Count label="Custom fields" value={preview.moves.customFields} />
            </Surface>
          </section>

          {preview.fills.length > 0 ? (
            <section aria-labelledby="fills-heading" className="flex flex-col gap-3">
              <h2 id="fills-heading" className="text-overline text-text-subtle uppercase">
                Details that fill a gap
              </h2>
              <Surface level={1} className="divide-y divide-line p-0">
                {preview.fills.map((fill) => (
                  <div key={fill.field} className="flex items-baseline gap-3 px-5 py-3">
                    <span className="w-28 shrink-0 text-caption text-text-subtle">
                      {fill.label}
                    </span>
                    <span className="text-body text-text">{fill.value}</span>
                    <Badge tone="signal" className="ml-auto">
                      Added
                    </Badge>
                  </div>
                ))}
              </Surface>
              <p className="text-caption text-text-subtle">
                {preview.survivor.displayName} has nothing recorded for these, so the duplicate’s
                values are kept. Nothing is lost.
              </p>
            </section>
          ) : null}

          {preview.conflicts.length > 0 ? (
            <section aria-labelledby="conflicts-heading" className="flex flex-col gap-3">
              <h2 id="conflicts-heading" className="text-overline text-text-subtle uppercase">
                Details that disagree — choose one
              </h2>
              <Surface level={1} className="divide-y divide-line p-0">
                {preview.conflicts.map((conflict) => (
                  <fieldset key={conflict.field} className="flex flex-col gap-2 px-5 py-4">
                    <legend className="text-caption text-text-subtle">{conflict.label}</legend>
                    <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-4">
                      <ChoiceOption
                        name={conflict.field}
                        value="survivor"
                        checked={(choices[conflict.field] ?? 'survivor') === 'survivor'}
                        label={conflict.survivorValue}
                        hint="Keep"
                        onChange={() =>
                          setChoices((current) => ({ ...current, [conflict.field]: 'survivor' }))
                        }
                      />
                      <ChoiceOption
                        name={conflict.field}
                        value="duplicate"
                        checked={choices[conflict.field] === 'duplicate'}
                        label={conflict.duplicateValue}
                        hint="Replace with"
                        onChange={() =>
                          setChoices((current) => ({ ...current, [conflict.field]: 'duplicate' }))
                        }
                      />
                    </div>
                  </fieldset>
                ))}
              </Surface>
              <p className="text-caption text-text-subtle">
                Values are never combined. If both are genuinely correct, cancel and record the
                second one somewhere it belongs first.
              </p>
            </section>
          ) : null}

          <Surface level={1} className="flex flex-col gap-3 border-attention-dim/50 p-5">
            <p className="text-body text-text">
              <strong className="font-medium">This cannot be undone.</strong>{' '}
              {preview.duplicate.displayName} becomes a redirect to {preview.survivor.displayName},
              and the {totalMoves} {totalMoves === 1 ? 'record' : 'records'} above move permanently.
            </p>

            {error ? (
              <p
                role="alert"
                className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
              >
                {error}
              </p>
            ) : null}

            <div className="flex gap-2">
              <Button variant="danger" loading={merging} onClick={() => void merge()}>
                Merge into {preview.survivor.displayName}
              </Button>
              <Button variant="ghost" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </Surface>
        </>
      ) : null}

      {error && !preview ? (
        <p role="alert" className="text-body text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-h3 text-text tabular-nums">{value}</span>
      <span className="text-caption text-text-subtle">{label}</span>
    </div>
  );
}

function ChoiceOption({
  name,
  value,
  checked,
  label,
  hint,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  hint: string;
  onChange: () => void;
}) {
  return (
    <label className="flex flex-1 cursor-pointer items-start gap-2 rounded-sm border border-line px-3 py-2 transition-colors duration-[120ms] hover:border-line-strong has-checked:border-signal">
      <input
        type="radio"
        name={`merge-${name}`}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-signal"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-caption text-text-subtle">{hint}</span>
        <span className="truncate text-body text-text">{label}</span>
      </span>
    </label>
  );
}
