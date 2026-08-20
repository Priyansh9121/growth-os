/**
 * PATCH /api/account/theme — record this person's palette choice.
 *
 * ⚠️ THE USER ID COMES FROM THE SESSION, NEVER FROM THE BODY.
 * `setThemePreference` writes to whichever user it is given, so the only thing
 * standing between a settings endpoint and an account-takeover primitive is
 * that the id is the one `requireActor` resolved from the session cookie. The
 * request body carries a theme and nothing else, and there is deliberately no
 * `userId` field to forget to ignore.
 *
 * ⚠️ AN UNKNOWN THEME IS REFUSED, NOT DEFAULTED. Coercing a bad value to `dark`
 * would tell the user their choice was saved and then show them something else.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { type NextResponse } from 'next/server';
import { updateThemePreferenceSchema, ValidationError } from '@growth-os/contracts';
import { setThemePreference } from '@growth-os/auth';
import {
  buildRequestContext,
  errorResponse,
  jsonResponse,
  rejectUntrustedOrigin,
} from '../../../../server/http';
import { requireActor } from '../../../../server/auth-context';
import { getDependencies } from '../../../../server/dependencies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request): Promise<NextResponse> {
  const context = buildRequestContext(request);
  try {
    const rejection = rejectUntrustedOrigin(request, context);
    if (rejection) return rejection;

    const body: unknown = await request.json().catch(() => null);
    const parsed = updateThemePreferenceSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Choose one of the available themes.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    // 401 when there is no valid session. A theme is not workspace-scoped, so
    // there is no workspace requirement here — a user with no workspaces yet
    // still gets to choose how the product looks.
    const { actor } = await requireActor();

    const stored = await setThemePreference(getDependencies().db, actor.userId, parsed.data.theme);

    // Null means the update matched no row — a session for a user that has
    // since been deleted. Reporting success would be a lie.
    if (!stored) throw new ValidationError('That account no longer exists.');

    return jsonResponse({ theme: stored }, context);
  } catch (error) {
    return errorResponse(error, context);
  }
}
