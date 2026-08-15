/**
 * Workspace settings for tags and custom contact fields.
 *
 * Admin-only. These decide the shape of the workspace's own customer data, and
 * a member inventing a tag vocabulary is how a workspace ends up unable to
 * segment by any of it.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { workspaceRoleHasCapability } from '@growth-os/contracts';
import { listCustomFields, listTags } from '@growth-os/crm';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../server/crm-server';
import { FieldSettings } from '../../../../components/crm/field-settings';
import { WorkspaceRequired } from '../../../../components/crm/workspace-required';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Tags and fields',
  description: 'Workspace tags and custom contact fields.',
};

export default async function CrmFieldsPage() {
  const { actor, workspace } = await requireAuthContext('/system/crm-fields');
  if (!workspace) return <WorkspaceRequired />;

  if (!workspaceRoleHasCapability(workspace.role, 'workspace:crm:tags:manage')) {
    notFound();
  }

  const crm = buildServerCrmContext(actor, workspace);
  const [tags, fields] = await Promise.all([listTags(crm, true), listCustomFields(crm, true)]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-h1 tracking-tight text-text">Tags and fields</h1>
        <p className="mt-1 text-body text-text-muted">
          What this workspace records about its customers, beyond the standard details.
        </p>
      </header>

      <FieldSettings initialTags={tags} initialFields={fields} />
    </div>
  );
}
