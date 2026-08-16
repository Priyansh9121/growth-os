'use client';

/**
 * The form editor.
 *
 * TWO PANELS: configuration on the left, a LIVE PREVIEW on the right that uses
 * `FormRenderer` — the same component the hosted form and the embed use. There
 * is deliberately no second preview implementation, because a preview that
 * renders differently from the real thing builds confidence in something that
 * was never tested.
 *
 * CONTROLLED FIELDS, NOT AN HTML EDITOR. Every property is a typed input over
 * a closed set. A drag-and-drop page builder is a different product, and one
 * that accepts arbitrary markup publishes an XSS vector to a customer's site.
 *
 * PUBLISHING IS SEPARATE FROM SAVING. Saving a live form republishes; saving a
 * draft does not, so editing a draft cannot accidentally put it in front of
 * the public.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FORM_FIELD_TARGET_LABELS,
  FORM_FIELD_TARGETS,
  FORM_FIELD_TYPE_LABELS,
  FORM_FIELD_TYPES,
  type FormDetailView,
  type FormFieldConfig,
  type FormFieldType,
  type PublicFormView,
} from '@growth-os/contracts';
import { Badge, Button, Surface } from '@growth-os/ui';
import { FormRenderer } from './form-renderer';

interface FormEditorProps {
  readonly form: FormDetailView;
  readonly canManage: boolean;
}

export function FormEditor({ form, canManage }: FormEditorProps) {
  const router = useRouter();
  const [fields, setFields] = useState<FormFieldConfig[]>([...(form.config?.fields ?? [])]);
  const [settings, setSettings] = useState(form.config?.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * The preview is built from the SAME projection the public path uses.
   *
   * `toPublicView` lives on the server, so this mirrors its shape — and
   * notably drops `target`, exactly as a real visitor's payload does.
   */
  const preview: PublicFormView = useMemo(
    () => ({
      publicKey: form.publicKey,
      name: form.name,
      fields: fields.map((field) => ({
        key: field.key,
        type: field.type,
        label: field.label,
        placeholder: field.placeholder ?? null,
        helpText: field.helpText ?? null,
        required: field.required,
        options: field.options ?? null,
        maxLength: field.maxLength,
      })),
      submitLabel: settings?.submitLabel ?? 'Send enquiry',
      theme: settings?.theme ?? 'auto',
      accent: settings?.accent ?? null,
      // The preview never renders a honeypot: it does not submit, and showing
      // a hidden trap would only confuse whoever inspects the markup.
      honeypotEnabled: false,
      honeypotKey: null,
    }),
    [fields, settings, form.name, form.publicKey],
  );

  async function save(status?: 'active' | 'inactive'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch(`/api/crm/forms/${form.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          config: { fields, settings },
          ...(status ? { status } : {}),
        }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        // The server's message names the actual rule — "a live form needs a
        // field mapped to Email or Phone" — and is shown verbatim, because it
        // is more useful than anything this component could invent.
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: { message?: string } }).error.message ?? '')
            : '';
        setError(message || 'Could not save.');
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function updateField(index: number, patch: Partial<FormFieldConfig>): void {
    setFields((current) =>
      current.map((field, i) => (i === index ? { ...field, ...patch } : field)),
    );
  }

  function addField(): void {
    const key = `field_${Date.now().toString(36)}`;
    setFields((current) => [
      ...current,
      {
        key,
        type: 'text',
        label: 'New field',
        required: false,
        target: 'none',
        maxLength: 500,
      },
    ]);
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-5">
        <section aria-labelledby="fields-heading" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 id="fields-heading" className="text-overline text-text-subtle uppercase">
              Fields
            </h2>
            {canManage ? (
              <Button variant="ghost" size="sm" onClick={addField}>
                Add field
              </Button>
            ) : null}
          </div>

          <Surface level={1} className="divide-y divide-line p-0">
            {fields.map((field, index) => (
              <fieldset key={field.key} className="flex flex-col gap-3 p-4">
                <legend className="sr-only">Field {index + 1}</legend>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <LabelledInput
                    label="Label"
                    value={field.label}
                    disabled={!canManage}
                    onChange={(value) => updateField(index, { label: value })}
                  />
                  <LabelledSelect
                    label="Type"
                    value={field.type}
                    disabled={!canManage}
                    options={FORM_FIELD_TYPES.map((type) => ({
                      value: type,
                      label: FORM_FIELD_TYPE_LABELS[type],
                    }))}
                    onChange={(value) => updateField(index, { type: value as FormFieldType })}
                  />
                  <LabelledInput
                    label="Placeholder"
                    value={field.placeholder ?? ''}
                    disabled={!canManage}
                    onChange={(value) => updateField(index, { placeholder: value || undefined })}
                  />
                  <LabelledSelect
                    label="Saves to"
                    value={field.target}
                    disabled={!canManage}
                    options={FORM_FIELD_TARGETS.map((target) => ({
                      value: target,
                      label: FORM_FIELD_TARGET_LABELS[target],
                    }))}
                    onChange={(value) => updateField(index, { target: value })}
                  />
                </div>

                {field.type === 'select' ? (
                  <LabelledInput
                    label="Choices, comma separated"
                    value={(field.options ?? []).join(', ')}
                    disabled={!canManage}
                    onChange={(value) =>
                      updateField(index, {
                        options: value
                          .split(',')
                          .map((option) => option.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                ) : null}

                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-caption text-text-muted">
                    <input
                      type="checkbox"
                      checked={field.required}
                      disabled={!canManage}
                      onChange={(event) => updateField(index, { required: event.target.checked })}
                      className="h-4 w-4 accent-signal"
                    />
                    Required
                  </label>
                  {canManage && fields.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setFields((current) => current.filter((_, i) => i !== index))}
                      className="text-caption text-text-subtle transition-colors duration-[120ms] hover:text-critical focus-visible:outline-none"
                    >
                      Remove {field.label}
                    </button>
                  ) : null}
                </div>
              </fieldset>
            ))}
          </Surface>
        </section>

        <section aria-labelledby="settings-heading" className="flex flex-col gap-3">
          <h2 id="settings-heading" className="text-overline text-text-subtle uppercase">
            After submitting
          </h2>
          <Surface level={1} className="flex flex-col gap-3 p-4">
            <LabelledInput
              label="Button label"
              value={settings?.submitLabel ?? ''}
              disabled={!canManage}
              onChange={(value) =>
                setSettings((current) => (current ? { ...current, submitLabel: value } : current))
              }
            />
            <LabelledInput
              label="Thank-you message"
              value={settings?.success.kind === 'message' ? settings.success.message : ''}
              disabled={!canManage || settings?.success.kind !== 'message'}
              onChange={(value) =>
                setSettings((current) =>
                  current ? { ...current, success: { kind: 'message', message: value } } : current,
                )
              }
            />

            <label className="flex items-center gap-2 text-caption text-text-muted">
              <input
                type="checkbox"
                checked={settings?.opportunity.enabled ?? false}
                disabled={!canManage}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          opportunity: { ...current.opportunity, enabled: event.target.checked },
                        }
                      : current,
                  )
                }
                className="h-4 w-4 accent-signal"
              />
              Open a deal in the pipeline for every enquiry
            </label>
          </Surface>
        </section>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
          >
            {error}
          </p>
        ) : null}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={busy} onClick={() => void save()}>
              Save changes
            </Button>
            {form.status === 'active' ? (
              <Button variant="ghost" onClick={() => void save('inactive')}>
                Pause form
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void save('active')}>
                Publish form
              </Button>
            )}
            {saved ? (
              <span role="status" className="text-caption text-signal">
                Saved
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <aside className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-overline text-text-subtle uppercase">Preview</h2>
          <Badge tone="neutral">Live</Badge>
        </div>
        <Surface level={1} className="p-5">
          {/* The SAME renderer the public form uses. `preview` disables
              submission; nothing else differs. */}
          <FormRenderer form={preview} preview />
        </Surface>
        <p className="text-caption text-text-subtle">
          This is the component your visitors see, not a mock-up of it.
        </p>
      </aside>
    </div>
  );
}

function LabelledInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = `editor-${label.replace(/\s+/g, '-').toLowerCase()}-${useMemo(() => Math.random().toString(36).slice(2, 8), [])}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption text-text-subtle">
        {label}
      </label>
      <input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-sm border border-line bg-surface-2 px-2.5 text-body text-text hover:border-line-strong focus-visible:outline-none disabled:opacity-60"
      />
    </div>
  );
}

function LabelledSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = `editor-${label.replace(/\s+/g, '-').toLowerCase()}-${useMemo(() => Math.random().toString(36).slice(2, 8), [])}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption text-text-subtle">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-sm border border-line bg-surface-2 px-2 text-body text-text hover:border-line-strong focus-visible:outline-none disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
