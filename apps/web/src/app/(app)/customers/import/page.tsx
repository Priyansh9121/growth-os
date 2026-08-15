/**
 * Import contacts from a CSV file.
 *
 * The page is a thin server shell: authorization, the past-imports list, and
 * the wizard. Everything interactive lives in the client component, because
 * the wizard is genuinely stateful across four steps.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { workspaceRoleHasCapability } from '@growth-os/contracts';
import { listImportBatches } from '@growth-os/crm';
import { Badge, Surface } from '@growth-os/ui';
import { IMPORT_STATUS_LABELS } from '@growth-os/contracts';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../server/crm-server';
import { ImportWizard } from '../../../../components/crm/import-wizard';
import { WorkspaceRequired } from '../../../../components/crm/workspace-required';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Import contacts' };

export default async function ImportPage() {
  const { actor, workspace } = await requireAuthContext('/customers/import');
  if (!workspace) return <WorkspaceRequired />;

  if (!workspaceRoleHasCapability(workspace.role, 'workspace:crm:contacts:import')) {
    notFound();
  }

  const batches = await listImportBatches(buildServerCrmContext(actor, workspace), 10);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header>
        <h1 className="text-h1 tracking-tight text-text">Import contacts</h1>
        <p className="mt-1 text-body text-text-muted">
          Bring an existing contact list in from a spreadsheet.
        </p>
      </header>

      <ImportWizard />

      {batches.length > 0 ? (
        <section aria-labelledby="past-imports" className="flex flex-col gap-3">
          <h2 id="past-imports" className="text-overline text-text-subtle uppercase">
            Previous imports
          </h2>
          <Surface level={1} className="divide-y divide-line p-0">
            {batches.map((batch) => (
              <div key={batch.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                <span className="min-w-0 flex-1 truncate text-body text-text">
                  {batch.filename}
                </span>
                <Badge
                  tone={
                    batch.status === 'completed'
                      ? 'signal'
                      : batch.status === 'partial'
                        ? 'attention'
                        : batch.status === 'failed'
                          ? 'critical'
                          : 'neutral'
                  }
                >
                  {IMPORT_STATUS_LABELS[batch.status]}
                </Badge>
                <span className="font-mono text-caption text-text-muted tabular-nums">
                  {batch.importedRows}/{batch.totalRows}
                </span>
                <time
                  dateTime={batch.startedAt}
                  className="font-mono text-caption text-text-subtle tabular-nums"
                >
                  {new Date(batch.startedAt).toLocaleDateString('en-AU')}
                </time>
              </div>
            ))}
          </Surface>
        </section>
      ) : null}
    </div>
  );
}
