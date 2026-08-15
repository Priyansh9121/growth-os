/** PATCH /api/crm/tasks/:id — update or complete. Tenant-scoped by the service. */
import { type NextResponse } from 'next/server';
import { updateTaskSchema, ValidationError } from '@growth-os/contracts';
import { completeTask, updateTask } from '@growth-os/crm';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../../server/http';
import { requireCrmContext } from '../../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = updateTaskSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid task update.');

    const crm = await requireCrmContext(context);

    // Completion goes through the dedicated service: it is idempotent and
    // writes a timeline entry, which a generic field update does not.
    const task =
      parsed.data.status === 'completed' && Object.keys(parsed.data).length === 1
        ? await completeTask(crm, id)
        : await updateTask(crm, id, parsed.data);

    return jsonResponse(task, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
