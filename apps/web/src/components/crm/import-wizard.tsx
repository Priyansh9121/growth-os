'use client';

/**
 * CSV import wizard.
 *
 * Upload → Map → Review → Import → Results.
 *
 * NOTHING IS WRITTEN UNTIL THE OPERATOR CROSSES THE REVIEW STEP. Selecting a
 * file uploads it for VALIDATION only; the server parses, checks every row and
 * returns counts without touching the database. An import that silently created
 * 4,000 contacts on file selection is not recoverable by any means this product
 * offers (ADR-0023 §1).
 *
 * The file is uploaded twice — once to validate, once to run — rather than held
 * on the server between steps. That costs one extra upload of at most 5 MB, and
 * buys a server that never stores a customer's file anywhere: no upload
 * directory to leak, scan, or forget to clean up.
 *
 * A PARTIAL IMPORT IS A REAL OUTCOME and the results step says so plainly,
 * with the row numbers, rather than rounding it to success or failure.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Surface } from '@growth-os/ui';
import {
  IMPORT_FIELD_TARGET_LABELS,
  IMPORT_FIELD_TARGETS,
  IMPORT_MAX_ROWS,
  IMPORT_STATUS_LABELS,
  type ImportFieldTarget,
  type ImportResult,
  type ImportRowIssue,
  type ImportValidation,
} from '@growth-os/contracts';
import { readErrorMessage } from './contact-tags';

type Step = 'upload' | 'map' | 'review' | 'results';

interface ValidationResponse extends ImportValidation {
  readonly headers: readonly string[];
  readonly truncatedRows: number;
}

/**
 * Guess a mapping from the column heading.
 *
 * A convenience, never a decision: every guess is shown in the mapping step
 * and can be changed before anything is written. Auto-mapping that the
 * operator could not see would make the import's behaviour depend on a
 * heuristic nobody reviewed.
 */
function guessTarget(header: string): ImportFieldTarget {
  const key = header.toLowerCase().replace(/[^a-z]/g, '');
  if (key.includes('firstname') || key === 'first' || key === 'givenname') return 'firstName';
  if (key.includes('lastname') || key === 'surname' || key === 'familyname') return 'lastName';
  if (key.includes('email')) return 'email';
  if (key.includes('mobile') || key.includes('phone')) return 'phone';
  if (key.includes('company') || key.includes('business') || key.includes('organisation')) {
    return 'companyName';
  }
  if (key.includes('source') || key.includes('referral')) return 'sourceDetail';
  return 'ignore';
}

export function ImportWizard() {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportFieldTarget>>({});
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(mode: 'validate' | 'run', body: FormData): Promise<unknown> {
    const response = await fetch(`/api/crm/import?mode=${mode}`, {
      method: 'POST',
      credentials: 'same-origin',
      body,
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readErrorMessage(parsed) || 'The import service refused that file.');
    }
    return parsed;
  }

  async function validate(candidate: File, columnMapping?: Record<string, ImportFieldTarget>) {
    setBusy(true);
    setError(null);

    try {
      const form = new FormData();
      form.set('file', candidate);
      if (columnMapping) form.set('mapping', JSON.stringify(columnMapping));

      const response = (await post('validate', form)) as ValidationResponse;
      setValidation(response);

      if (!columnMapping) {
        // First pass: the server has told us the headings, so propose a
        // mapping and show it for review.
        setMapping(
          Object.fromEntries(response.headers.map((header) => [header, guessTarget(header)])),
        );
        setStep('map');
      } else {
        setStep('review');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!file) return;
    setBusy(true);
    setError(null);

    try {
      const form = new FormData();
      form.set('file', file);
      form.set('mapping', JSON.stringify(mapping));
      setResult((await post('run', form)) as ImportResult);
      setStep('results');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The import did not complete.');
    } finally {
      setBusy(false);
    }
  }

  const mappedTargets = Object.values(mapping);
  const hasFirstName = mappedTargets.includes('firstName');
  const hasIdentity = mappedTargets.includes('email') || mappedTargets.includes('phone');

  return (
    <div className="flex flex-col gap-5">
      <Steps current={step} />

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {error}
        </p>
      ) : null}

      {step === 'upload' ? (
        <Surface level={1} className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="text-h3 text-text">Choose a CSV file</h2>
            <p className="mt-1 text-body text-text-muted">
              Up to 5 MB and {IMPORT_MAX_ROWS.toLocaleString('en-AU')} rows. Nothing is saved until
              you have seen what will happen.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="import-file" className="text-caption font-medium text-text-muted">
              CSV file
            </label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                if (chosen) void validate(chosen);
              }}
              className="text-body text-text-muted file:mr-3 file:h-9 file:rounded-sm file:border file:border-line file:bg-surface-2 file:px-3 file:text-body file:text-text"
            />
          </div>

          <p className="text-caption text-text-subtle">
            Every imported enquiry is recorded as{' '}
            <span className="text-text-muted">added by import</span>. A “Source” column is kept as a
            note against the enquiry — it is never treated as measured attribution, because a
            spreadsheet saying “Google” is someone’s recollection rather than something we observed.
          </p>
        </Surface>
      ) : null}

      {step === 'map' && validation ? (
        <Surface level={1} className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="text-h3 text-text">Match your columns</h2>
            <p className="mt-1 text-body text-text-muted">
              {validation.totalRows.toLocaleString('en-AU')} rows found. Columns left as “Do not
              import” are ignored entirely.
            </p>
          </div>

          <ul className="flex flex-col divide-y divide-line">
            {validation.headers.map((header) => (
              <li key={header} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-text-muted">
                  {header}
                </span>
                <span aria-hidden="true" className="text-text-subtle">
                  →
                </span>
                <label htmlFor={`map-${header}`} className="sr-only">
                  Import {header} as
                </label>
                <select
                  id={`map-${header}`}
                  value={mapping[header] ?? 'ignore'}
                  onChange={(event) =>
                    setMapping((current) => ({
                      ...current,
                      [header]: event.target.value as ImportFieldTarget,
                    }))
                  }
                  className="h-8 w-44 rounded-sm border border-line bg-surface-2 px-2 text-caption text-text hover:border-line-strong focus-visible:outline-none"
                >
                  {IMPORT_FIELD_TARGETS.map((target) => (
                    <option key={target} value={target}>
                      {IMPORT_FIELD_TARGET_LABELS[target]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>

          {!hasFirstName || !hasIdentity ? (
            <p className="text-body text-attention">
              Map a first name, and at least an email address or a phone number. Without one of
              those there is no way to tell two people apart.
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              disabled={!file || !hasFirstName || !hasIdentity}
              loading={busy}
              onClick={() => file && void validate(file, mapping)}
            >
              Check the rows
            </Button>
            <Button variant="ghost" onClick={() => setStep('upload')}>
              Choose a different file
            </Button>
          </div>
        </Surface>
      ) : null}

      {step === 'review' && validation ? (
        <Surface level={1} className="flex flex-col gap-4 p-5">
          <h2 className="text-h3 text-text">Review before importing</h2>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Count label="Rows in file" value={validation.totalRows} />
            <Count label="Will import" value={validation.validRows} tone="signal" />
            <Count
              label="Already in the CRM"
              value={validation.matchesExisting}
              tone={validation.matchesExisting > 0 ? 'attention' : undefined}
            />
            <Count
              label="Cannot import"
              value={validation.issues.length}
              tone={validation.issues.length > 0 ? 'critical' : undefined}
            />
          </div>

          {validation.matchesExisting > 0 ? (
            <p className="text-body text-text-muted">
              {validation.matchesExisting}{' '}
              {validation.matchesExisting === 1 ? 'row matches a person' : 'rows match people'} you
              already have. Their enquiry is added to the existing record — no duplicate contact is
              created.
            </p>
          ) : null}

          {validation.truncatedRows > 0 ? (
            <p className="text-body text-attention">
              This file has {validation.truncatedRows.toLocaleString('en-AU')} rows beyond the{' '}
              {IMPORT_MAX_ROWS.toLocaleString('en-AU')}-row limit. They will not be imported. Split
              the file and run it again to bring them in.
            </p>
          ) : null}

          <IssueList issues={validation.issues} />

          <div className="flex gap-2">
            <Button disabled={validation.validRows === 0} loading={busy} onClick={() => void run()}>
              Import {validation.validRows.toLocaleString('en-AU')}{' '}
              {validation.validRows === 1 ? 'row' : 'rows'}
            </Button>
            <Button variant="ghost" onClick={() => setStep('map')}>
              Back to columns
            </Button>
          </div>
        </Surface>
      ) : null}

      {step === 'results' && result ? (
        <Surface level={1} className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <h2 className="text-h3 text-text">Import {IMPORT_STATUS_LABELS[result.status]}</h2>
            <Badge
              tone={
                result.status === 'completed'
                  ? 'signal'
                  : result.status === 'partial'
                    ? 'attention'
                    : 'critical'
              }
            >
              {IMPORT_STATUS_LABELS[result.status]}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Count label="Imported" value={result.importedRows} tone="signal" />
            <Count label="Matched existing" value={result.matchedExistingRows} />
            <Count
              label="Failed"
              value={result.failedRows}
              tone={result.failedRows > 0 ? 'critical' : undefined}
            />
            <Count label="Rows in file" value={result.totalRows} />
          </div>

          {result.status === 'partial' ? (
            <p className="text-body text-attention">
              Some rows were written and some were not. The rows below did not import; the rest are
              already in your CRM. Fixing and re-running this file will not duplicate them.
            </p>
          ) : null}

          <IssueList issues={result.issues} />

          <div className="flex gap-2">
            <Button onClick={() => window.location.reload()}>Import another file</Button>
            <Link
              href="/customers/contacts"
              className="inline-flex h-9 items-center rounded-md border border-line px-3.5 text-body text-text-muted transition-colors duration-[120ms] hover:border-line-strong hover:text-text focus-visible:outline-none"
            >
              View contacts
            </Link>
          </div>
        </Surface>
      ) : null}
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const steps: readonly { id: Step; label: string }[] = [
    { id: 'upload', label: 'Choose file' },
    { id: 'map', label: 'Match columns' },
    { id: 'review', label: 'Review' },
    { id: 'results', label: 'Results' },
  ];
  const currentIndex = steps.findIndex((step) => step.id === current);

  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-2">
          <span
            aria-current={step.id === current ? 'step' : undefined}
            className={
              index < currentIndex
                ? 'text-text-muted'
                : step.id === current
                  ? 'font-medium text-signal'
                  : 'text-text-subtle'
            }
          >
            {index + 1}. {step.label}
          </span>
          {index < steps.length - 1 ? (
            <span aria-hidden="true" className="text-text-subtle">
              ·
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Row-level problems, reported BY NUMBER.
 *
 * The number is what lets an operator find the row in their own spreadsheet.
 * "Some rows failed" is not an actionable report on a 3,000-row file.
 */
function IssueList({ issues }: { issues: readonly ImportRowIssue[] }) {
  if (issues.length === 0) return null;

  return (
    <details className="rounded-md border border-line">
      <summary className="cursor-pointer px-3.5 py-2.5 text-body text-text-muted">
        {issues.length} {issues.length === 1 ? 'row needs' : 'rows need'} attention
      </summary>
      <ul className="max-h-64 divide-y divide-line overflow-y-auto border-t border-line">
        {issues.map((issue) => (
          <li key={`${issue.row}-${issue.message}`} className="flex gap-3 px-3.5 py-2">
            <span className="w-14 shrink-0 font-mono text-caption text-text-subtle tabular-nums">
              Row {issue.row}
            </span>
            {/* The message names the field and the rule. The offending VALUE
                is never echoed back — it is customer data, and this string
                ends up in a browser and possibly a screenshot. */}
            <span className="text-caption text-text-muted">{issue.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'signal' | 'attention' | 'critical' | undefined;
}) {
  const colour =
    tone === 'signal'
      ? 'text-signal'
      : tone === 'attention'
        ? 'text-attention'
        : tone === 'critical'
          ? 'text-critical'
          : 'text-text';

  return (
    <div className="flex flex-col gap-0.5">
      <span className={`font-mono text-h3 tabular-nums ${colour}`}>
        {value.toLocaleString('en-AU')}
      </span>
      <span className="text-caption text-text-subtle">{label}</span>
    </div>
  );
}
