'use client';

/**
 * Workspace settings for tags and custom fields.
 *
 * ONE SCREEN FOR TWO THINGS, on purpose. Both are the workspace deciding what
 * shape its own customer data takes, both are admin-only, and both have the
 * same governing rule: **archive, never delete.** Deleting a tag would silently
 * untag every contact carrying it; deleting a field definition would cascade
 * away every value a workspace entered under it (ADR-0013, ADR-0022).
 *
 * The consequences of each choice are stated inline rather than in
 * documentation nobody opens — a key cannot be reused, a type cannot change,
 * and an option cannot be removed once contacts may hold it.
 */

import { useState } from 'react';
import { Badge, Button, Surface } from '@growth-os/ui';
import {
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  TAG_TONES,
  type CustomFieldDefinitionView,
  type CustomFieldType,
  type TagTone,
  type TagView,
} from '@growth-os/contracts';
import { readErrorMessage } from './contact-tags';

interface FieldSettingsProps {
  readonly initialTags: readonly TagView[];
  readonly initialFields: readonly CustomFieldDefinitionView[];
}

export function FieldSettings({ initialTags, initialFields }: FieldSettingsProps) {
  return (
    <div className="flex flex-col gap-8">
      <TagSettings initialTags={initialTags} />
      <CustomFieldSettings initialFields={initialFields} />
    </div>
  );
}

function TagSettings({ initialTags }: { initialTags: readonly TagView[] }) {
  const [tags, setTags] = useState<readonly TagView[]>(initialTags);
  const [name, setName] = useState('');
  const [tone, setTone] = useState<TagTone>('neutral');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/crm/tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name, tone }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readErrorMessage(body) || 'Could not create that tag.');
        return;
      }

      setTags((current) =>
        [...current, body as TagView].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setName('');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="tags-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="tags-heading" className="text-h3 text-text">
          Tags
        </h2>
        <p className="mt-1 text-body text-text-muted">
          Labels anyone in the workspace can apply to a contact. Only admins define them, so the
          vocabulary stays consistent enough to segment by.
        </p>
      </div>

      <Surface level={1} className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-tag-name" className="text-caption font-medium text-text-muted">
              Tag name
            </label>
            <input
              id="new-tag-name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              className="h-9 w-56 rounded-sm border border-line bg-surface-2 px-2.5 text-body text-text hover:border-line-strong focus-visible:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-tag-tone" className="text-caption font-medium text-text-muted">
              Colour
            </label>
            <select
              id="new-tag-tone"
              value={tone}
              onChange={(event) => setTone(event.target.value as TagTone)}
              className="h-9 rounded-sm border border-line bg-surface-2 px-2 text-body text-text hover:border-line-strong focus-visible:outline-none"
            >
              {TAG_TONES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <Button loading={busy} disabled={name.trim() === ''} onClick={() => void create()}>
            Add tag
          </Button>
        </div>

        <p className="text-caption text-text-subtle">
          Colours come from a fixed set rather than a colour picker, so every tag stays legible in
          both light and dark themes.
        </p>

        {error ? (
          <p role="alert" className="text-body text-critical">
            {error}
          </p>
        ) : null}

        {tags.length > 0 ? (
          <ul className="flex flex-wrap gap-2 border-t border-line pt-4">
            {tags.map((tag) => (
              <li key={tag.id} className="inline-flex items-center gap-1.5">
                <Badge tone={tag.tone}>{tag.name}</Badge>
                <span className="font-mono text-caption text-text-subtle tabular-nums">
                  {tag.contactCount}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Surface>
    </section>
  );
}

function CustomFieldSettings({
  initialFields,
}: {
  initialFields: readonly CustomFieldDefinitionView[];
}) {
  const [fields, setFields] = useState<readonly CustomFieldDefinitionView[]>(initialFields);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Derive the machine key from the label, once, at creation.
   *
   * The key never changes afterwards — it is what every stored value points at.
   * Deriving it here rather than asking for it keeps the form to one field
   * without giving up the stability that makes renaming a label safe.
   */
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  async function create(): Promise<void> {
    if (key === '' || busy) return;
    setBusy(true);
    setError(null);

    const parsedOptions = options
      .split('\n')
      .map((option) => option.trim())
      .filter((option) => option.length > 0);

    try {
      const response = await fetch('/api/crm/custom-fields', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          key,
          label: label.trim(),
          type,
          required: false,
          ...(type === 'single_select' ? { options: parsedOptions } : {}),
        }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readErrorMessage(body) || 'Could not create that field.');
        return;
      }

      setFields((current) => [...current, body as CustomFieldDefinitionView]);
      setLabel('');
      setOptions('');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="fields-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="fields-heading" className="text-h3 text-text">
          Custom contact fields
        </h2>
        <p className="mt-1 text-body text-text-muted">
          Extra details your business records about a person — property type, patient type, vehicle
          registration.
        </p>
      </div>

      <Surface level={1} className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-field-label" className="text-caption font-medium text-text-muted">
              Field name
            </label>
            <input
              id="new-field-label"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              className="h-9 w-56 rounded-sm border border-line bg-surface-2 px-2.5 text-body text-text hover:border-line-strong focus-visible:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-field-type" className="text-caption font-medium text-text-muted">
              Type
            </label>
            <select
              id="new-field-type"
              value={type}
              onChange={(event) => setType(event.target.value as CustomFieldType)}
              className="h-9 rounded-sm border border-line bg-surface-2 px-2 text-body text-text hover:border-line-strong focus-visible:outline-none"
            >
              {CUSTOM_FIELD_TYPES.map((option) => (
                <option key={option} value={option}>
                  {CUSTOM_FIELD_TYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </div>

          <Button loading={busy} disabled={key === ''} onClick={() => void create()}>
            Add field
          </Button>
        </div>

        {type === 'single_select' ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-field-options" className="text-caption font-medium text-text-muted">
              Choices, one per line
            </label>
            <textarea
              id="new-field-options"
              rows={4}
              value={options}
              onChange={(event) => setOptions(event.target.value)}
              className="w-full max-w-sm rounded-sm border border-line bg-surface-2 px-2.5 py-2 text-body text-text hover:border-line-strong focus-visible:outline-none"
            />
            <p className="text-caption text-text-subtle">
              Choices can be added later, but never removed — a contact holding a removed choice
              would keep a value nothing displays.
            </p>
          </div>
        ) : null}

        <p className="text-caption text-text-subtle">
          A field’s type cannot be changed after it is created, because changing it would
          reinterpret every value already stored. Archive the field and make a new one instead.
        </p>

        {error ? (
          <p role="alert" className="text-body text-critical">
            {error}
          </p>
        ) : null}

        {fields.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {fields.map((field) => (
              <li key={field.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-body text-text">{field.label}</span>
                <code className="font-mono text-caption text-text-subtle">{field.key}</code>
                <Badge tone="neutral">{CUSTOM_FIELD_TYPE_LABELS[field.type]}</Badge>
                {field.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Surface>

      <p className="text-caption text-text-subtle">
        Custom field values are never sent to Growth AI. They are where the most sensitive and least
        predictable details end up, so no AI tool reads them.
      </p>
    </section>
  );
}
