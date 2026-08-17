/**
 * /api/crm/sites — the workspace's web properties.
 *
 * Shared with the Stage 4 crawler and Search Console later, which is why this
 * is a CRM-adjacent route rather than a forms one: a site is a property of the
 * workspace, not a setting on a form (ADR-0029).
 *
 * `sites:manage` is separate from `forms:manage` on purpose — registering a
 * website is a claim about what the business owns, and a later stage will
 * require DNS verification to back it.
 */

import { type NextResponse } from 'next/server';
import { createSiteSchema, ValidationError } from '@growth-os/contracts';
import { createSite, listSites } from '@growth-os/sites';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../server/http';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildFormsContext } from '../../../../server/forms/dependencies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');
    const sites = await listSites(buildFormsContext(actor, workspace, context.correlationId));
    return jsonResponse({ sites }, context);
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
    const parsed = createSiteSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Check the website address.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');

    // The origin is normalised in the service, so `abcplumbing.test` and
    // `https://abcplumbing.test/contact?x=1` cannot become two rows for one
    // website.
    const site = await createSite(
      buildFormsContext(actor, workspace, context.correlationId),
      parsed.data,
    );
    return jsonResponse(site, context, 201);
  } catch (error) {
    return errorResponse(error, context);
  }
}
