'use client';

/**
 * Create a form.
 *
 * One field. A form starts as a DRAFT with a sensible default configuration —
 * name, email, phone, message — because the useful first action is editing a
 * real form, not filling in a creation wizard before seeing anything.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Surface } from '@growth-os/ui';

export function CreateFormButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    if (name.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/crm/forms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: { message?: string } }).error.message ?? '')
            : '';
        setError(message || 'Could not create that form.');
        return;
      }

      router.push(`/conversion/forms/${(body as { id: string }).id}`);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <Button onClick={() => setOpen(true)}>New form</Button>;

  return (
    <Surface level={1} className="flex w-full flex-col gap-3 p-4 sm:w-96">
      <Field
        label="Form name"
        value={name}
        autoFocus
        maxLength={120}
        description="Shown to you, not to visitors."
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void create();
        }}
      />
      {error ? (
        <p role="alert" className="text-caption text-critical">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button loading={busy} disabled={name.trim().length === 0} onClick={() => void create()}>
          Create
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Surface>
  );
}
