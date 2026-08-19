/**
 * /api/crm/crawls — start a crawl, and list a site's crawls.
 *
 * ⚠️ THE FIRST ROUTE THAT CAUSES OUTBOUND TRAFFIC TO A CUSTOMER-NAMED DOMAIN.
 * Nothing here decides whether that is allowed. `requestCrawl` does, and it
 * refuses unless the site is VERIFIED — before it writes anything, so a refused
 * request leaves no crawl row and no queued job (ADR-0054). Adding a shortcut
 * here that skipped it would turn Growth OS into an arbitrary internet-scanning
 * service anyone can drive by typing a domain.
 *
 * POST does NOT run the crawl. It queues a job and returns; a crawl is minutes
 * of network I/O and an HTTP handler is not where that belongs.
 *
 * @see docs/decisions/ADR-0054-starting-a-crawl.md
 */

import { type NextResponse } from 'next/server';
import { ValidationError } from '@growth-os/contracts';
import { listCrawlsForSite, requestCrawl } from '@growth-os/sites';
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

/** GET /api/crm/crawls?siteId=… — a site's crawl history, newest first. */
export async function GET(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const siteId = new URL(request.url).searchParams.get('siteId');
    if (!siteId) throw new ValidationError('siteId is required.');

    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');

    // `crawls:read`, enforced in the service — a viewer sees results.
    const crawls = await listCrawlsForSite(
      buildFormsContext(actor, workspace, context.correlationId),
      siteId,
    );
    return jsonResponse({ crawls }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}

/** POST /api/crm/crawls — queue a crawl of a verified site. */
export async function POST(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const body: unknown = await request.json().catch(() => null);
    const siteId =
      body && typeof body === 'object' && 'siteId' in body
        ? (body as { siteId: unknown }).siteId
        : null;
    if (typeof siteId !== 'string' || siteId.length === 0) {
      throw new ValidationError('Choose a website to crawl.');
    }

    const { actor, workspace } = await requireAuthContext();
    if (!workspace) throw new ValidationError('No workspace selected.');

    // `crawls:run` AND verification, both in the service, both before any
    // write. The trigger is not taken from the request: this endpoint is a
    // person pressing a button, and `scheduled` is a claim only the scheduler
    // gets to make.
    const requested = await requestCrawl(
      buildFormsContext(actor, workspace, context.correlationId),
      { siteId },
    );

    // 202, not 201. The crawl is queued, not done — and the operator polls
    // /api/crm/crawls/:id to find out which.
    return jsonResponse(requested, context, 202);
  } catch (error) {
    return errorResponse(error, context);
  }
}
