/**
 * POST /api/public/forms/:publicKey/submissions — the anonymous write path.
 *
 * ⚠️ THE PRODUCT'S FIRST ENDPOINT REACHABLE BY ANYONE ON THE INTERNET.
 *
 * Everything about it differs from the authenticated API, and each difference
 * is deliberate:
 *
 * **No CSRF origin check.** Public submissions are intentionally cross-site —
 * that is the entire point of an embed. Copying `rejectUntrustedOrigin` here
 * would refuse every real customer embed. Tenant safety comes from the public
 * key resolving to exactly one workspace, not from an `Origin` header a
 * non-browser sets to whatever it likes (ADR-0026 §5).
 *
 * **No session, no cookie, no actor.** The workspace is resolved from the key,
 * and ingestion runs under a system grant of exactly `contacts:write`
 * (ADR-0025).
 *
 * **A body limit before parsing.** A lead form does not accept 20 MB of JSON,
 * and a limit checked after `await request.json()` has already spent the
 * memory it was meant to bound.
 *
 * **One response for every refusal.** Spam, rate limits, a paused form, an
 * unknown key and a validation failure all answer identically. Telling a bot
 * which signal caught it is telling it what to change; the operator sees the
 * real reason in their submissions list.
 *
 * @see docs/security/public-forms-threat-model.md
 */

import { NextResponse } from 'next/server';
import { publicSubmissionSchema, type PublicSubmissionResponse } from '@growth-os/contracts';
import { resolvePublicForm, submitPublicForm } from '@growth-os/forms';
import { getDependencies } from '../../../../../../server/dependencies';
import { getSubmitDependencies } from '../../../../../../server/forms/dependencies';
import { buildRequestContext } from '../../../../../../server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 32 KB.
 *
 * Generous for a lead form — a 30-field form with 2,000-character answers fits
 * several times over — and small enough that flooding this endpoint costs the
 * attacker more than it costs us.
 */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * The single public refusal.
 *
 * Deliberately vague and deliberately identical for every cause. Status 200,
 * not 4xx: a bot that can distinguish rejections by status code learns the same
 * thing it would learn from a message. A real visitor sees the form's error
 * state either way.
 */
function refuse(): NextResponse {
  return NextResponse.json(
    { ok: false, message: 'This form could not accept your submission. Please try again later.' },
    { status: 200, headers: corsHeaders() },
  );
}

/**
 * CORS for the embed.
 *
 * `*` is correct here, and is not the security hole it looks like. This
 * endpoint is designed to be called from arbitrary customer websites; it
 * carries no cookies (`Access-Control-Allow-Credentials` is absent, so a
 * browser will not attach them); and it returns no internal identifiers. There
 * is nothing an attacker's page learns by calling it that it could not learn by
 * calling it from a server.
 *
 * Restricting this to a form's allowed origins would break the moment a
 * customer added a staging domain, and would buy nothing — `Origin` is checked
 * separately as an abuse signal, where its real strength is understood.
 */
function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    // This endpoint's response must never be cached by a CDN — an idempotent
    // retry has to reach the server to be recognised as one.
    'cache-control': 'no-store',
  };
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

type Params = { params: Promise<{ publicKey: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const context = buildRequestContext(request);

  try {
    const { publicKey } = await params;

    // Size, before parsing. `Content-Length` is a client-supplied hint, so the
    // decoded body is checked too — the header only lets us refuse early.
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuse();

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return refuse();

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return refuse();
    }

    const parsed = publicSubmissionSchema.safeParse(body);
    if (!parsed.success) return refuse();

    // RESOLUTION: the key, and nothing the caller said, decides the tenant.
    const form = await resolvePublicForm(getDependencies().db, publicKey);
    if (!form) return refuse();

    const result = await submitPublicForm(getSubmitDependencies(), {
      form,
      input: parsed.data,
      ipAddress: context.ipAddress,
      origin: request.headers.get('origin'),
      correlationId: context.correlationId,
    });

    if (result.kind === 'rejected') return refuse();

    const response: PublicSubmissionResponse = {
      ok: true,
      // The caller's OWN submission id, echoed back. It confirms their retry
      // was recognised while disclosing nothing of ours — no contact id, no
      // acquisition id, no workspace id.
      reference: result.reference,
      success: result.success,
    };

    return NextResponse.json(response, { status: 200, headers: corsHeaders() });
  } catch {
    // Deliberately swallowed. An anonymous caller learns nothing from an
    // internal error — including a reused-idempotency-key conflict, which
    // would otherwise confirm that a given submission id was seen before.
    //
    // The error IS recorded: the submission service writes a receipt before
    // rethrowing, so the operator sees it. Nothing is silently lost.
    return refuse();
  }
}
