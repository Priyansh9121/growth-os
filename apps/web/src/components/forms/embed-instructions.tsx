'use client';

/**
 * Embed instructions.
 *
 * ⚠️ THE PUBLIC KEY IS SHOWN IN FULL, and that is correct. It is not a secret:
 * it appears in the customer's page source and in a URL, and every security
 * property holds with it fully public (ADR-0026 §1). Treating it as a secret
 * here — masking it, warning about it — would teach the operator something
 * false about how the system works.
 *
 * What is NOT shown: the workspace id, the form id, or anything else internal.
 */

import { useState } from 'react';
import { Badge, Surface } from '@growth-os/ui';
import type { FormStatus } from '@growth-os/contracts';

export function EmbedInstructions({
  publicKey,
  appUrl,
  status,
}: {
  publicKey: string;
  appUrl: string;
  status: FormStatus;
}) {
  const hostedUrl = `${appUrl}/f/${publicKey}`;
  const snippet = `<script src="${appUrl}/embed.js" data-growth-form="${publicKey}"></script>`;

  return (
    <section aria-labelledby="embed-heading" className="flex flex-col gap-3">
      <h2 id="embed-heading" className="text-overline text-text-subtle uppercase">
        Put it on your website
      </h2>

      {status !== 'active' ? (
        <p className="rounded-md border border-attention-dim/50 bg-attention-dim/10 px-3.5 py-2.5 text-body text-attention">
          This form is not live yet. The link and snippet below will not accept enquiries until you
          publish it.
        </p>
      ) : null}

      <Surface level={1} className="flex flex-col gap-5 p-5">
        <Copyable
          label="Direct link"
          description="Share this anywhere — an email, a social profile, a QR code. No website needed."
          value={hostedUrl}
        />
        <Copyable
          label="Website snippet"
          description="Paste this where the form should appear. It loads in a sandboxed frame, so your site's styles and ours cannot affect each other."
          value={snippet}
        />
        <p className="text-caption text-text-subtle">
          The snippet adds under 1 KB to your page. If your site blocks external scripts, use the
          direct link above in an <code className="font-mono">iframe</code> instead — the form works
          identically, it just will not resize itself.
        </p>
      </Surface>
    </section>
  );
}

function Copyable({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-caption font-medium text-text-muted">{label}</span>
        {copied ? <Badge tone="signal">Copied</Badge> : null}
      </div>
      <p className="text-caption text-text-subtle">{description}</p>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-sm border border-line bg-surface-2 px-2.5 py-2 font-mono text-caption text-text">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            });
          }}
          className="shrink-0 rounded-md border border-line px-3 text-caption text-text-muted transition-colors duration-[120ms] hover:border-line-strong hover:text-text focus-visible:outline-none"
        >
          Copy<span className="sr-only"> {label}</span>
        </button>
      </div>
    </div>
  );
}
