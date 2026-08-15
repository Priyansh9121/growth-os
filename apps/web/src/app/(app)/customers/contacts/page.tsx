/**
 * Contacts list page.
 *
 * A Server Component: the first page of contacts is fetched server-side and
 * streamed as HTML, so the operator sees data on first paint rather than a
 * spinner followed by a fetch. Subsequent search and pagination happen
 * client-side against the same API.
 */

import type { Metadata } from 'next';
import { workspaceRoleHasCapability } from '@growth-os/contracts';
import { listContacts } from '@growth-os/crm';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../server/crm-server';
import { ContactsTable } from '../../../../components/crm/contacts-table';
import { WorkspaceRequired } from '../../../../components/crm/workspace-required';

export const metadata: Metadata = { title: 'Contacts' };
export const dynamic = 'force-dynamic';

export default async function ContactsPage() {
  const { actor, workspace } = await requireAuthContext('/customers/contacts');
  if (!workspace) return <WorkspaceRequired />;

  const crm = buildServerCrmContext(actor, workspace);
  const initialPage = await listContacts(crm, {
    limit: 25,
    sort: 'createdAt',
    direction: 'desc',
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-h1 tracking-tight text-text">Contacts</h1>
        <p className="text-body text-text-muted">
          Everyone {workspace.workspaceName} has heard from, and where they came from.
        </p>
      </header>

      <ContactsTable
        initialPage={initialPage}
        canCreate={workspaceRoleHasCapability(workspace.role, 'workspace:crm:contacts:write')}
      />
    </div>
  );
}
