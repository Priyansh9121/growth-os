'use client';

/**
 * The Ask Growth AI panel.
 *
 * ⚠️  NO LANGUAGE MODEL IS CONNECTED. This component is explicit about that in
 * the interface, not just in a comment.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The user-facing end of the AI boundary. It calls `/api/ai/ask`, which runs a
 * real typed tool through the real authorization and validation guard chain,
 * and renders the result.
 *
 * WHY IT SAYS SO OUT LOUD
 * Principle 3. It would be trivial to render a plausible paragraph of
 * "analysis" here and it would demo better. It would also be a lie, and the
 * product's entire value rests on its numbers being trustworthy. The panel
 * shows what the tool actually returned and states that no model is connected.
 *
 * @see docs/architecture/ai-agent-architecture.md
 */

import { useState, type FormEvent } from 'react';
import { Badge, Button, Surface } from '@growth-os/ui';

interface EvidenceMetric {
  key: string;
  label: string;
  formatted: string;
  provenance: string;
}

interface AskResponse {
  mode: string;
  notice?: string;
  toolName?: string;
  autonomyLabel?: string;
  evidence?: {
    workspaceName: string;
    periodLabel: string;
    provenance: string;
    metrics: EvidenceMetric[];
  };
}

const SUGGESTIONS = [
  'What should I work on this week?',
  'Where are we losing leads?',
  'Which keyword produces the most revenue?',
] as const;

export function AskGrowthAi({ workspaceId }: { workspaceId: string }) {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);

    try {
      const result = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ question: trimmed, workspaceId }),
      });

      const body = (await result.json()) as AskResponse & { error?: { message: string } };

      if (!result.ok) {
        setError(body.error?.message ?? 'Growth AI could not respond.');
        return;
      }

      setResponse(body);
    } catch {
      setError('Growth AI could not be reached.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Surface level={1} className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-h3 text-text">Ask Growth AI</h2>
        <div className="flex items-center gap-2">
          <Badge tone="neutral">Draft with approval</Badge>
          <Badge tone="fixture">No model connected</Badge>
        </div>
      </div>

      <p className="text-caption text-text-subtle">
        The typed tool boundary, authorization and audit trail are implemented. A language model is
        connected at Stage 7 — until then this returns the raw output of the{' '}
        <code className="font-mono text-text-muted">growth.getSnapshot</code> tool.
      </p>

      <form onSubmit={submit} className="flex flex-col gap-2.5 sm:flex-row">
        <label htmlFor="growth-ai-question" className="sr-only">
          Ask Growth AI a question
        </label>
        <input
          id="growth-ai-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={pending}
          maxLength={1000}
          placeholder="What should I work on this week?"
          className="h-11 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3.5 text-body text-text transition-colors duration-[120ms] placeholder:text-text-subtle hover:border-line-strong focus-visible:outline-none disabled:opacity-60"
        />
        <Button type="submit" loading={pending} loadingLabel="Asking Growth AI" size="md">
          Ask
        </Button>
      </form>

      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => setQuestion(suggestion)}
            disabled={pending}
            className="rounded-full border border-line px-2.5 py-1 text-caption text-text-muted transition-colors duration-[120ms] hover:border-line-strong hover:text-text focus-visible:outline-none disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* Results are announced politely — they arrive after a user action but
          should not interrupt what someone is reading. */}
      <div aria-live="polite" aria-atomic="false">
        {error ? (
          <p role="alert" className="text-caption text-critical">
            {error}
          </p>
        ) : null}

        {response?.evidence ? (
          <div className="rounded-md border border-line bg-surface-2 p-4">
            <p className="text-caption text-text-muted">{response.notice}</p>

            <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3">
              {response.evidence.metrics.map((metric) => (
                <div key={metric.key} className="flex flex-col gap-0.5">
                  <dt className="text-caption text-text-subtle">{metric.label}</dt>
                  <dd className="font-mono text-sm text-text tabular-nums">{metric.formatted}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-3 border-t border-line pt-2.5 text-caption text-text-subtle">
              Returned by <code className="font-mono">{response.toolName}</code> · provenance{' '}
              {response.evidence.provenance} · {response.evidence.periodLabel}
            </p>
          </div>
        ) : null}
      </div>
    </Surface>
  );
}
