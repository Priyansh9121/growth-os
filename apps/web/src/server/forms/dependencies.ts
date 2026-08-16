import 'server-only';

/**
 * Lead capture composition.
 *
 * The public submission path's dependencies, assembled in one place so the
 * hosted form, the embed and the API cannot drift into different limits, a
 * different challenge provider, or a different notion of "our own origin".
 */

import { NoChallengeVerifier, type FormsContext, type SubmitDependencies } from '@growth-os/forms';
import type { Actor, WorkspaceAccess } from '@growth-os/contracts';
import { getDependencies } from '../dependencies';
import { getEventPublisher } from '../crm-context';

/**
 * Dependencies for an anonymous submission.
 *
 * The challenge verifier is `NoChallengeVerifier` — which ACCEPTS EVERYTHING,
 * and says so in its name. No CAPTCHA provider is configured; the rate limits
 * and content signals are what actually run. A silently permissive
 * pass-through would let "we have CAPTCHA" become true in conversation and
 * false in production.
 */
export function getSubmitDependencies(): SubmitDependencies {
  const deps = getDependencies();
  return {
    db: deps.db,
    events: getEventPublisher(),
    challenge: new NoChallengeVerifier(),
    // From configuration, never from the request Host header — a first-party
    // origin derived from a caller-supplied header is not a check.
    appUrl: deps.env.APP_URL,
  };
}

/** The authenticated forms context, for admin routes and pages. */
export function buildFormsContext(
  actor: Actor,
  workspace: WorkspaceAccess,
  correlationId: string | null = null,
): FormsContext {
  return {
    deps: { db: getDependencies().db, events: getEventPublisher() },
    tenant: { actor, workspace },
    correlationId,
  };
}
