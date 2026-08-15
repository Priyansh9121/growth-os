/** Tasks page — the operator's work queue. */
import type { Metadata } from 'next';
import { workspaceRoleHasCapability } from '@growth-os/contracts';
import { listTasks } from '@growth-os/crm';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../server/crm-server';
import { TasksList } from '../../../../components/crm/tasks-list';
import { WorkspaceRequired } from '../../../../components/crm/workspace-required';

export const metadata: Metadata = { title: 'Tasks' };
export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const { actor, workspace } = await requireAuthContext('/customers/tasks');
  if (!workspace) return <WorkspaceRequired />;

  const crm = buildServerCrmContext(actor, workspace);
  const initialPage = await listTasks(crm, { limit: 50, status: 'open', scope: 'all' });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-h1 tracking-tight text-text">Tasks</h1>
        <p className="text-body text-text-muted">What needs doing, and when.</p>
      </header>

      <TasksList
        initialPage={initialPage}
        canWrite={workspaceRoleHasCapability(workspace.role, 'workspace:crm:tasks:write')}
      />
    </div>
  );
}
