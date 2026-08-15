/** /api/crm/tasks — list and create. */
import { type NextResponse } from 'next/server';
import { createTaskSchema, taskFiltersSchema, ValidationError } from '@growth-os/contracts';
import { createTask, listTasks } from '@growth-os/crm';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../server/http';
import { requireCrmContext } from '../../../../server/crm-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const url = new URL(request.url);
    const parsed = taskFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new ValidationError('Invalid filters.');
    const crm = await requireCrmContext(context);
    return jsonResponse(await listTasks(crm, parsed.data), context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const body: unknown = await request.json().catch(() => null);
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the details you entered.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const crm = await requireCrmContext(context);
    return jsonResponse(await createTask(crm, parsed.data), context, 201);
  } catch (error) {
    return errorResponse(error, context);
  }
}
