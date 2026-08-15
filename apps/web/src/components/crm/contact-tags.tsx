'use client';

/**
 * Tag chips on the contact detail page.
 *
 * NO OPTIMISTIC LIES (the Stage 2 rule, applied again)
 * A chip does not appear until the server confirms it, and the list rendered
 * afterwards is the server's own answer rather than a locally-patched copy.
 * Tags drive segmentation, so a chip that looks applied but is not would send
 * the wrong list of people the wrong campaign.
 *
 * The picker is a native `<select>` plus a button. That is operable by
 * keyboard, screen reader and touch with no custom interaction code — a
 * custom combobox would need its own focus management, announcement and
 * type-ahead protocol to match it.
 */

import { useState } from 'react';
import { Badge, Button } from '@growth-os/ui';
import type { ContactTagView, TagView } from '@growth-os/contracts';

interface ContactTagsProps {
  readonly contactId: string;
  readonly initialTags: readonly ContactTagView[];
  readonly available: readonly TagView[];
  readonly canApply: boolean;
}

export function ContactTags({ contactId, initialTags, available, canApply }: ContactTagsProps) {
  const [tags, setTags] = useState<readonly ContactTagView[]>(initialTags);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const unapplied = available.filter(
    (tag) => tag.archivedAt === null && !tags.some((applied) => applied.id === tag.id),
  );

  async function send(method: 'POST' | 'DELETE', tagId: string, label: string): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const url =
        method === 'DELETE'
          ? `/api/crm/contacts/${contactId}/tags?tagId=${encodeURIComponent(tagId)}`
          : `/api/crm/contacts/${contactId}/tags`;

      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        ...(method === 'POST' ? { body: JSON.stringify({ tagId }) } : {}),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readErrorMessage(body) || 'Could not update tags.');
        return;
      }

      // The server's list, not a local edit of ours.
      setTags((body as { tags: ContactTagView[] }).tags);
      setSelected('');
      setAnnouncement(method === 'POST' ? `${label} applied` : `${label} removed`);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Chips relocating in the DOM is not perceivable to a screen-reader
          user, so each change is announced. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 ? (
          <span className="text-caption text-text-subtle">No tags</span>
        ) : (
          tags.map((tag) => (
            <span key={tag.id} className="inline-flex items-center gap-1">
              <Badge tone={tag.tone}>{tag.name}</Badge>
              {canApply ? (
                <button
                  type="button"
                  onClick={() => void send('DELETE', tag.id, tag.name)}
                  disabled={pending}
                  className="grid h-5 w-5 place-items-center rounded-xs text-text-subtle transition-colors duration-[120ms] hover:text-critical focus-visible:outline-none disabled:opacity-50"
                >
                  <span className="sr-only">Remove tag {tag.name}</span>
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>

      {canApply && unapplied.length > 0 ? (
        <div className="flex items-center gap-2">
          <label htmlFor={`tag-picker-${contactId}`} className="sr-only">
            Add a tag
          </label>
          <select
            id={`tag-picker-${contactId}`}
            value={selected}
            disabled={pending}
            onChange={(event) => setSelected(event.target.value)}
            className="h-8 rounded-sm border border-line bg-surface-2 px-2 text-caption text-text-muted transition-colors duration-[120ms] hover:border-line-strong focus-visible:outline-none disabled:opacity-50"
          >
            <option value="">Add a tag…</option>
            {unapplied.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            disabled={selected === '' || pending}
            loading={pending}
            onClick={() => {
              const tag = unapplied.find((candidate) => candidate.id === selected);
              if (tag) void send('POST', tag.id, tag.name);
            }}
          >
            Add
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-caption text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Pull the operator-facing message out of an error envelope, if there is one. */
export function readErrorMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('error' in body)) return '';
  const envelope = (body as { error?: { message?: unknown } }).error;
  return typeof envelope?.message === 'string' ? envelope.message : '';
}
