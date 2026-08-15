'use client';

/**
 * Contact erasure — the confirmation surface.
 *
 * WHAT THIS SCREEN HAS TO GET RIGHT
 * The most common misunderstanding of "erase this customer" is that it deletes
 * the sale. It does not — and an operator who believes it does will avoid using
 * a feature they may be legally obliged to use. So the panel gives equal space
 * to what SURVIVES as to what goes, and both lists come from the server rather
 * than from a hard-coded sentence that could drift from the implementation.
 *
 * THE TYPED CONFIRMATION IS NOT A SECURITY CONTROL
 * Anyone who can reach this button can type five letters. Its only job is to
 * put a deliberate pause between "I clicked the wrong row" and an action with
 * no undo. Treating it as a control would be theatre; leaving it out would make
 * an irreversible operation a single click away from an accidental one.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Surface } from '@growth-os/ui';
import { ERASURE_CONFIRMATION_PHRASE, type ErasurePreview } from '@growth-os/contracts';
import { readErrorMessage } from './contact-tags';

interface EraseContactProps {
  readonly contactId: string;
  readonly displayName: string;
}

export function EraseContact({ contactId, displayName }: EraseContactProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ErasurePreview | null>(null);
  const [typed, setTyped] = useState('');
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setError(null);

    void fetch(`/api/crm/contacts/${contactId}/erase`, { credentials: 'same-origin' })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setError(readErrorMessage(body) || 'Could not load what erasure would affect.');
          return;
        }
        setPreview(body as ErasurePreview);
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach the server.');
      });

    return () => {
      cancelled = true;
    };
  }, [open, contactId]);

  async function erase(): Promise<void> {
    if (typed !== ERASURE_CONFIRMATION_PHRASE || erasing) return;

    setErasing(true);
    setError(null);

    try {
      const response = await fetch(`/api/crm/contacts/${contactId}/erase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ confirmation: typed }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readErrorMessage(body) || 'The erasure did not complete.');
        return;
      }

      router.refresh();
      setOpen(false);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setErasing(false);
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Erase personal details…
      </Button>
    );
  }

  const blocked = (preview?.blockers.length ?? 0) > 0;

  return (
    <Surface
      level={2}
      className="flex flex-col gap-4 border-critical/40 p-5"
      role="group"
      aria-labelledby="erase-heading"
    >
      <div>
        <h2 id="erase-heading" className="text-h3 text-text">
          Erase {displayName}’s personal details
        </h2>
        <p className="mt-1 text-body text-text-muted">
          This is permanent. There is no way to restore the details afterwards.
        </p>
      </div>

      {blocked ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-critical">
          {preview?.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}

      {preview && !blocked ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <h3 className="text-overline text-text-subtle uppercase">Removed</h3>
            <ul className="mt-2 flex flex-col gap-1 text-body text-text-muted">
              <li>Name, email address and phone number</li>
              <Cleared count={preview.clears.acquisitions} noun="enquiry" plural="enquiries">
                identifying detail on
              </Cleared>
              <Cleared count={preview.clears.opportunities} noun="deal" plural="deals">
                the title of
              </Cleared>
              <Cleared count={preview.clears.tasks} noun="task" plural="tasks">
                the wording of
              </Cleared>
              <Cleared
                count={preview.clears.activities}
                noun="timeline entry"
                plural="timeline entries"
              >
                the wording of
              </Cleared>
              <Cleared
                count={preview.clears.customFields}
                noun="custom value"
                plural="custom values"
              >
                all
              </Cleared>
              <Cleared count={preview.clears.tags} noun="tag" plural="tags">
                all
              </Cleared>
            </ul>
          </div>

          <div>
            <h3 className="text-overline text-text-subtle uppercase">Kept</h3>
            {/* Read from the server rather than written here, so this list
                cannot drift from what the erasure actually does. */}
            <ul className="mt-2 flex flex-col gap-1 text-body text-text-muted">
              {preview.retained.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {!blocked ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="erase-confirm" className="text-caption font-medium text-text-muted">
            Type {ERASURE_CONFIRMATION_PHRASE} to confirm
          </label>
          <input
            id="erase-confirm"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
            className="h-9 w-40 rounded-sm border border-line bg-surface-2 px-2 font-mono text-body text-text hover:border-line-strong focus-visible:outline-none"
          />
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          variant="danger"
          loading={erasing}
          disabled={blocked || typed !== ERASURE_CONFIRMATION_PHRASE}
          onClick={() => void erase()}
        >
          Erase permanently
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setTyped('');
          }}
        >
          Cancel
        </Button>
      </div>
    </Surface>
  );
}

/** Renders a count line, or nothing at all when the count is zero. */
function Cleared({
  count,
  noun,
  plural,
  children,
}: {
  count: number;
  noun: string;
  plural: string;
  children: string;
}) {
  if (count === 0) return null;
  return (
    <li>
      {children} {count} {count === 1 ? noun : plural}
    </li>
  );
}
