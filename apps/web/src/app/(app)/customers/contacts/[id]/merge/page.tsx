/**
 * Merge a duplicate into this contact.
 *
 * A page rather than a modal, deliberately. The decision needs the whole
 * viewport — two records side by side, six move counts, and a per-field choice
 * — and it needs a URL, so an operator can send it to a colleague and ask
 * "should I do this?" before doing something with no undo.
 *
 * `:id` is the SURVIVOR. Candidates are matched on exact email or phone only,
 * never on name (ADR-0015).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { isAppError, workspaceRoleHasCapability } from '@growth-os/contracts';
import { findMergeCandidates, getContact } from '@growth-os/crm';
import { requireAuthContext } from '../../../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../../../server/crm-server';
import { MergePanel } from '../../../../../../components/crm/merge-panel';
import { WorkspaceRequired } from '../../../../../../components/crm/workspace-required';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Merge contact' };

type Params = { params: Promise<{ id: string }> };

export default async function MergeContactPage({ params }: Params) {
  const { id } = await params;
  const { actor, workspace } = await requireAuthContext(`/customers/contacts/${id}/merge`);
  if (!workspace) return <WorkspaceRequired />;

  // Checked here as well as in the service. The service is the enforcement
  // point; this is so a member is not shown a screen they cannot use.
  if (!workspaceRoleHasCapability(workspace.role, 'workspace:crm:contacts:merge')) {
    notFound();
  }

  const crm = buildServerCrmContext(actor, workspace);

  let contact;
  try {
    contact = await getContact(crm, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }

  const candidates = await findMergeCandidates(crm, id);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <nav aria-label="Breadcrumb">
        <Link
          href={`/customers/contacts/${id}`}
          className="text-caption text-text-muted transition-colors duration-[120ms] hover:text-text focus-visible:outline-none"
        >
          ← {contact.displayName}
        </Link>
      </nav>

      <header>
        <h1 className="text-h1 tracking-tight text-text">Merge into {contact.displayName}</h1>
        <p className="mt-1 text-body text-text-muted">
          This record survives. The one you choose becomes a redirect to it.
        </p>
      </header>

      <MergePanel survivorId={id} candidates={candidates} />
    </div>
  );
}
