/**
 * Forms — the operator's list.
 *
 * The screen that answers "is this working?", so the submission and lead
 * counts are on the row rather than behind a click. A forms list without them
 * is a list of configuration.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FORM_STATUS_LABELS, workspaceRoleHasCapability } from '@growth-os/contracts';
import { listForms } from '@growth-os/forms';
import { Badge, Surface } from '@growth-os/ui';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildFormsContext } from '../../../../server/forms/dependencies';
import { CreateFormButton } from '../../../../components/forms/create-form-button';
import { WorkspaceRequired } from '../../../../components/crm/workspace-required';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Forms',
  description: 'Lead capture forms and where they are embedded.',
};

export default async function FormsPage() {
  const { actor, workspace } = await requireAuthContext('/conversion/forms');
  if (!workspace) return <WorkspaceRequired />;

  if (!workspaceRoleHasCapability(workspace.role, 'workspace:forms:read')) notFound();
  const canManage = workspaceRoleHasCapability(workspace.role, 'workspace:forms:manage');

  const forms = await listForms(buildFormsContext(actor, workspace));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1 tracking-tight text-text">Forms</h1>
          <p className="mt-1 text-body text-text-muted">
            Capture enquiries from your website, with the source they came from.
          </p>
        </div>
        {canManage ? <CreateFormButton /> : null}
      </header>

      {forms.length === 0 ? (
        <Surface level={1} className="p-8 text-center">
          <p className="text-body text-text-muted">No forms yet.</p>
          <p className="mt-2 text-caption text-text-subtle">
            A form gives you a page you can link to, and a snippet you can paste into your website.
            Every enquiry becomes a contact with its source recorded.
          </p>
        </Surface>
      ) : (
        <Surface level={1} className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] border-collapse">
            <caption className="sr-only">
              Forms in this workspace, with submission counts and the last time each received one.
            </caption>
            <thead>
              <tr className="border-b border-line">
                <Th>Form</Th>
                <Th>Status</Th>
                <Th align="right">Leads</Th>
                <Th align="right">Submissions</Th>
                <Th align="right">Last enquiry</Th>
              </tr>
            </thead>
            <tbody>
              {forms.map((form) => (
                <tr key={form.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-3">
                    <Link
                      href={`/conversion/forms/${form.id}`}
                      className="text-body text-text hover:text-signal focus-visible:outline-none"
                    >
                      {form.name}
                    </Link>
                    {form.siteOrigin ? (
                      <p className="text-caption text-text-subtle">{form.siteOrigin}</p>
                    ) : null}
                  </td>
                  <td className="px-5 py-3">
                    <Badge
                      tone={
                        form.status === 'active'
                          ? 'signal'
                          : form.status === 'inactive'
                            ? 'attention'
                            : 'neutral'
                      }
                    >
                      {FORM_STATUS_LABELS[form.status]}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-body text-text tabular-nums">
                    {form.leadCount}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-caption text-text-muted tabular-nums">
                    {form.submissionCount}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-caption text-text-subtle tabular-nums">
                    {form.lastSubmissionAt
                      ? new Date(form.lastSubmissionAt).toLocaleDateString('en-AU')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Surface>
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`px-5 py-2.5 text-overline text-text-subtle uppercase ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
