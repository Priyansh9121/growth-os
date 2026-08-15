/**
 * Pipeline board page.
 *
 * Provisions the default pipeline on first visit rather than failing with an
 * empty state: a workspace that has never configured a pipeline should still
 * be able to work, and the template is a fixture the workspace can then edit.
 */

import type { Metadata } from 'next';
import { workspaceRoleHasCapability } from '@growth-os/contracts';
import { ensureDefaultPipeline, findDefaultPipeline, listOpportunities } from '@growth-os/crm';
import { Surface } from '@growth-os/ui';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../server/crm-server';
import { PipelineBoard } from '../../../../components/crm/pipeline-board';
import { WorkspaceRequired } from '../../../../components/crm/workspace-required';

export const metadata: Metadata = { title: 'Pipeline' };
export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const { actor, workspace } = await requireAuthContext('/customers/pipeline');
  if (!workspace) return <WorkspaceRequired />;

  const crm = buildServerCrmContext(actor, workspace);

  // Only an admin may create a pipeline, so a member visiting a workspace that
  // has none sees an honest empty state rather than an authorization error.
  const canManage = workspaceRoleHasCapability(workspace.role, 'workspace:crm:pipelines:manage');
  const pipeline = canManage ? await ensureDefaultPipeline(crm) : await findDefaultPipeline(crm);

  if (!pipeline) {
    return (
      <Surface level={1} className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-h2 text-text">No pipeline configured</h1>
        <p className="mt-2 text-body text-text-muted">
          An administrator needs to set up a pipeline before deals can be tracked.
        </p>
      </Surface>
    );
  }

  const deals = await listOpportunities(crm, { pipelineId: pipeline.id, limit: 100 });

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-h1 tracking-tight text-text">Pipeline</h1>
        <p className="text-body text-text-muted">
          Deals in progress across {workspace.workspaceName}.
        </p>
      </header>

      <PipelineBoard
        pipeline={pipeline}
        opportunities={deals.items}
        currency={pipeline.currency}
        canMove={workspaceRoleHasCapability(workspace.role, 'workspace:crm:opportunities:write')}
      />
    </div>
  );
}
