/**
 * Form detail — configuration, embed instructions and submissions.
 *
 * Three sections in the order an operator needs them: build it, put it on
 * their site, then watch it work.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError, workspaceRoleHasCapability } from '@growth-os/contracts';
import { getForm, listSubmissions } from '@growth-os/forms';
import { requireAuthContext } from '../../../../../server/auth-context';
import { buildFormsContext } from '../../../../../server/forms/dependencies';
import { getDependencies } from '../../../../../server/dependencies';
import { FormEditor } from '../../../../../components/forms/form-editor';
import { EmbedInstructions } from '../../../../../components/forms/embed-instructions';
import { SubmissionsTable } from '../../../../../components/forms/submissions-table';
import { WorkspaceRequired } from '../../../../../components/crm/workspace-required';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Form' };

type Params = { params: Promise<{ id: string }> };

export default async function FormDetailPage({ params }: Params) {
  const { id } = await params;
  const { actor, workspace } = await requireAuthContext(`/conversion/forms/${id}`);
  if (!workspace) return <WorkspaceRequired />;
  if (!workspaceRoleHasCapability(workspace.role, 'workspace:forms:read')) notFound();

  const context = buildFormsContext(actor, workspace);

  let form;
  try {
    form = await getForm(context, id);
  } catch (error) {
    // A form in another workspace produces 404, never 403.
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }

  const submissions = await listSubmissions(context, id, 25);
  const canManage = workspaceRoleHasCapability(workspace.role, 'workspace:forms:manage');

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="Breadcrumb">
        <Link
          href="/conversion/forms"
          className="text-caption text-text-muted transition-colors duration-[120ms] hover:text-text focus-visible:outline-none"
        >
          ← Forms
        </Link>
      </nav>

      <header>
        <h1 className="text-h1 tracking-tight text-text">{form.name}</h1>
        <p className="mt-1 text-body text-text-muted">
          {form.leadCount} {form.leadCount === 1 ? 'lead' : 'leads'} from {form.submissionCount}{' '}
          {form.submissionCount === 1 ? 'submission' : 'submissions'}
          {form.version !== null ? ` · version ${form.version} live` : ' · not published yet'}
        </p>
      </header>

      <FormEditor form={form} canManage={canManage} />

      <EmbedInstructions
        publicKey={form.publicKey}
        appUrl={getDependencies().env.APP_URL}
        status={form.status}
      />

      <section aria-labelledby="submissions-heading" className="flex flex-col gap-3">
        <h2 id="submissions-heading" className="text-overline text-text-subtle uppercase">
          Recent submissions
        </h2>
        <SubmissionsTable submissions={submissions} />
      </section>
    </div>
  );
}
