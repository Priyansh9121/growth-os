'use client';

/**
 * Custom field values on the contact detail page.
 *
 * The form is RENDERED FROM THE DEFINITIONS, not hard-coded: the type decides
 * the control, the options decide a `<select>`'s contents. That is the whole
 * reason definitions are a table rather than a JSONB blob — a client cannot
 * render a form for a shape it has no description of (ADR-0022).
 *
 * Each field saves on blur rather than through one page-level Save button.
 * A workspace may define dozens; a single form that must be submitted as a
 * whole makes correcting one value a much larger action than it is, and makes
 * a validation failure anywhere block saving everywhere.
 */

import { useState } from 'react';
import { Spinner } from '@growth-os/ui';
import type { CustomFieldDefinitionView, CustomFieldValueView } from '@growth-os/contracts';
import { readErrorMessage } from './contact-tags';

interface ContactCustomFieldsProps {
  readonly contactId: string;
  readonly definitions: readonly CustomFieldDefinitionView[];
  readonly initialValues: readonly CustomFieldValueView[];
  readonly canEdit: boolean;
}

export function ContactCustomFields({
  contactId,
  definitions,
  initialValues,
  canEdit,
}: ContactCustomFieldsProps) {
  const [values, setValues] = useState<readonly CustomFieldValueView[]>(initialValues);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (definitions.length === 0) return null;

  async function save(definitionId: string, value: string | number | boolean | null) {
    setSavingId(definitionId);
    setErrors((current) => {
      const next = { ...current };
      delete next[definitionId];
      return next;
    });

    try {
      const response = await fetch(`/api/crm/contacts/${contactId}/fields`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ definitionId, value }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        // The server's validation message names the field and the rule — it is
        // the authority on what a "number" or a "date" means here, so it is
        // shown verbatim rather than replaced with a generic string.
        setErrors((current) => ({
          ...current,
          [definitionId]: readErrorMessage(body) || 'Could not save.',
        }));
        return;
      }

      setValues((body as { values: CustomFieldValueView[] }).values);
    } catch {
      setErrors((current) => ({ ...current, [definitionId]: 'Could not reach the server.' }));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
      {definitions.map((definition) => {
        const current = values.find((value) => value.definitionId === definition.id);
        const error = errors[definition.id];
        const inputId = `custom-${definition.id}`;

        return (
          <div key={definition.id} className="flex flex-col gap-1">
            <dt>
              <label htmlFor={inputId} className="text-caption text-text-subtle">
                {definition.label}
                {definition.required ? (
                  <span aria-hidden="true" className="ml-0.5 text-critical">
                    *
                  </span>
                ) : null}
              </label>
            </dt>
            <dd className="flex items-center gap-2">
              <FieldControl
                id={inputId}
                definition={definition}
                value={current?.value ?? null}
                disabled={!canEdit || savingId === definition.id}
                invalid={error !== undefined}
                onCommit={(value) => void save(definition.id, value)}
              />
              {savingId === definition.id ? (
                <>
                  <Spinner size={14} />
                  {/* The spinner is decorative; the state change is announced
                      in text, because a spinning SVG is invisible to a screen
                      reader. */}
                  <span className="sr-only" role="status">
                    Saving {definition.label}
                  </span>
                </>
              ) : null}
            </dd>
            {error ? (
              <p role="alert" className="text-caption text-critical">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}

const CONTROL_CLASSES =
  'h-8 w-full rounded-sm border bg-surface-2 px-2 text-body text-text transition-colors duration-[120ms] focus-visible:outline-none disabled:opacity-50';

function FieldControl({
  id,
  definition,
  value,
  disabled,
  invalid,
  onCommit,
}: {
  id: string;
  definition: CustomFieldDefinitionView;
  value: string | number | boolean | null;
  disabled: boolean;
  invalid: boolean;
  onCommit: (value: string | number | boolean | null) => void;
}) {
  const border = invalid ? 'border-critical' : 'border-line hover:border-line-strong';

  if (definition.type === 'boolean') {
    return (
      <select
        id={id}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        defaultValue={value === null ? '' : String(value)}
        onChange={(event) =>
          onCommit(event.target.value === '' ? null : event.target.value === 'true')
        }
        className={`${CONTROL_CLASSES} ${border}`}
      >
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  if (definition.type === 'single_select') {
    return (
      <select
        id={id}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        defaultValue={value === null ? '' : String(value)}
        onChange={(event) => onCommit(event.target.value === '' ? null : event.target.value)}
        className={`${CONTROL_CLASSES} ${border}`}
      >
        <option value="">—</option>
        {(definition.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  // Text, number and date all commit on blur. `onChange` would fire a request
  // per keystroke; a form-level submit would make one bad value block the rest.
  return (
    <input
      id={id}
      type={definition.type === 'number' ? 'number' : definition.type === 'date' ? 'date' : 'text'}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      defaultValue={value === null ? '' : String(value)}
      onBlur={(event) => {
        const raw = event.target.value.trim();
        if (raw === '') {
          onCommit(null);
          return;
        }
        onCommit(definition.type === 'number' ? Number(raw) : raw);
      }}
      className={`${CONTROL_CLASSES} ${border}`}
    />
  );
}
