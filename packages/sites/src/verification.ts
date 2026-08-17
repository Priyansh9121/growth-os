/**
 * Site ownership verification.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turn "this workspace typed a domain into a form" into "this workspace
 * demonstrated control of that domain", because those are different facts and
 * only the second one authorises crawling it.
 *
 * ⚠️ THE THREAT THIS EXISTS TO STOP
 * Without verification, Growth OS is an **arbitrary internet scanning service
 * that anyone can drive by signing up and typing a domain**. Someone types
 * `competitor.example`, presses Start crawl, and our infrastructure fetches
 * five hundred pages of a site we have no relationship with — from our IP
 * addresses, with our user agent, at our legal risk.
 *
 * Verification is what makes the crawler a tool a business points at its own
 * property rather than a weapon it points at somebody else's.
 *
 * ⚠️ THE TOKEN IS A PROOF, NOT A CREDENTIAL.
 * It is published in a customer's page source or in public DNS. Holding it
 * grants nothing; what it demonstrates is control of a place only the owner can
 * write to. Every property here must hold with the token fully public — which
 * is why it is checked against a specific site rather than looked up by value.
 *
 * ⚠️ THE CHECK IS SERVER-SIDE, ALWAYS.
 * There is no code path anywhere that accepts `verified: true` from a client,
 * and the HTTP method uses the SAME `safeFetch` the crawler uses. A second,
 * unguarded fetcher "just for verification" would be an SSRF hole in the one
 * endpoint whose entire job is to take a stranger's URL.
 *
 * @see docs/decisions/ADR-0031-site-verification.md
 */

import { randomBytes } from 'node:crypto';
// ⚠️ THE ONE SANCTIONED EXCEPTION TO THE NETWORK BOUNDARY (AGENTS.md §5).
//
// A TXT lookup asks the configured resolver a question; it opens no
// connection to the host being asked about, so there is no SSRF surface to
// route through `safeFetch` — and routing it there would make it perform a
// request it currently does not. Recorded in ADR-0031 so nobody "fixes the
// inconsistency" later. Every HTTP path in this file goes through safeFetch.
// eslint-disable-next-line no-restricted-syntax
import { resolveTxt } from 'node:dns/promises';
import { and, eq } from 'drizzle-orm';
import {
  ValidationError,
  type SiteVerificationFailure,
  type SiteVerificationMethod,
} from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import { safeFetch, type SafeFetchDependencies } from '@growth-os/net';
import {
  actorUserIdOrNull,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  type SitesContext,
} from './context';

const { sites } = schemaTables;

/** The DNS label a TXT proof is published under. */
export const VERIFICATION_DNS_LABEL = '_growth-os-verification';
/** The meta tag name an HTML proof is published under. */
export const VERIFICATION_META_NAME = 'growth-os-verification';

/**
 * 128 bits, hex — the same shape and the same database CHECK as a form's public
 * key.
 *
 * Not because it is a secret (it is not; see the header) but because a
 * guessable proof is not a proof. With 128 bits, publishing a token nobody can
 * predict is what makes "this string is on your homepage" evidence of anything.
 */
export function generateVerificationToken(): string {
  return randomBytes(16).toString('hex');
}

export interface VerificationInstructions {
  readonly token: string;
  readonly method: SiteVerificationMethod;
  /** Exactly what the operator must publish. Shown verbatim in the UI. */
  readonly snippet: string;
  /** Where it goes, in one sentence. */
  readonly location: string;
}

/**
 * Issue (or re-issue) a token and return the instructions for both methods.
 *
 * ⚠️ ONE TOKEN SERVES BOTH METHODS. Two tokens would mean an operator who
 * pasted the meta tag and then tried DNS would be told their correct record was
 * wrong — a support call created by an implementation detail.
 *
 * Re-issuing ROTATES the token and, if the site was verified, does NOT
 * un-verify it: a business that rotates its proof has not stopped owning its
 * domain. What rotation does is invalidate the old published string, so a
 * customer who removed a tag from a site they sold cannot have it re-verified
 * by whoever bought it.
 */
export async function issueVerificationToken(
  context: SitesContext,
  siteId: string,
): Promise<{
  readonly siteId: string;
  readonly instructions: readonly VerificationInstructions[];
}> {
  requireCapability(context, 'workspace:sites:manage');

  return inTenant(context, async (tx, workspace) => {
    const site = await loadInTenant(tx, sites, workspace, siteId, 'Site');
    const token = generateVerificationToken();
    const now = contextNow(context);

    await tx
      .update(sites)
      .set({
        verificationToken: token,
        verificationTokenIssuedAt: now,
        // `pending` only from `unverified`. A verified site stays verified
        // while its owner rotates the proof.
        ...(site.verificationState === 'unverified'
          ? { verificationState: 'pending' as const }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(sites.id, siteId), eq(sites.workspaceId, workspace)));

    return { siteId, instructions: instructionsFor(token, site.origin) };
  });
}

export function instructionsFor(
  token: string,
  origin: string,
): readonly VerificationInstructions[] {
  let host = origin;
  try {
    host = new URL(origin).hostname;
  } catch {
    /* the CHECK constraint makes this unreachable; the fallback is harmless */
  }

  return [
    {
      token,
      method: 'html_meta',
      snippet: `<meta name="${VERIFICATION_META_NAME}" content="${token}" />`,
      location: `In the <head> of your homepage at ${origin}`,
    },
    {
      token,
      method: 'dns_txt',
      snippet: `${VERIFICATION_DNS_LABEL}.${host}  TXT  "${VERIFICATION_META_NAME}=${token}"`,
      location: `As a TXT record on ${host}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export type VerificationResult =
  | { readonly verified: true; readonly method: SiteVerificationMethod }
  | { readonly verified: false; readonly failure: SiteVerificationFailure };

/**
 * Look up TXT records. Injectable so tests need no DNS.
 *
 * ⚠️ THIS IS NOT AN SSRF SURFACE. A TXT lookup asks the configured resolver a
 * question; it opens no connection to the host being asked about. That is why
 * it does not go through `@growth-os/net` — and why saying so here matters, so
 * nobody later "fixes the inconsistency" by routing it through a fetcher that
 * would then have to make a request it currently does not.
 */
export interface TxtResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export const systemTxtResolver: TxtResolver = { resolveTxt };

export interface VerificationDependencies {
  readonly network: SafeFetchDependencies;
  readonly txt: TxtResolver;
}

/**
 * Check the proof and, if it holds, mark the site verified.
 *
 * Tries the HTML meta tag first, then DNS. Both are checked on every attempt
 * rather than requiring the operator to declare which they used: making someone
 * choose a method before they have succeeded at one is a form that can be
 * filled in wrongly for no reason.
 */
export async function verifySite(
  context: SitesContext,
  deps: VerificationDependencies,
  siteId: string,
): Promise<VerificationResult> {
  requireCapability(context, 'workspace:sites:verify');

  const { token, origin } = await inTenant(context, async (tx, workspace) => {
    const site = await loadInTenant(tx, sites, workspace, siteId, 'Site');
    if (!site.verificationToken) {
      throw new ValidationError('Generate a verification code for this website first.');
    }
    return { token: site.verificationToken, origin: site.origin };
  });

  const outcome = await checkProof(deps, origin, token);

  const now = contextNow(context);
  await inTenant(context, async (tx, workspace) => {
    await tx
      .update(sites)
      .set({
        verificationCheckedAt: now,
        ...(outcome.verified
          ? {
              verificationState: 'verified' as const,
              verifiedAt: now,
              verificationMethod: outcome.method,
            }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(sites.id, siteId), eq(sites.workspaceId, workspace)));
  });

  if (outcome.verified) {
    context.deps.events.publish({
      name: 'seo.site.verified',
      workspaceId: context.tenant.workspace.workspaceId,
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      actorType: context.system ? 'system' : 'user',
      actorUserId: actorUserIdOrNull(context),
      siteId,
      method: outcome.method,
    });
  }

  return outcome;
}

/**
 * The pure-ish half: does the proof exist, right now, on that origin?
 *
 * Exported so the check can be exercised without a database.
 */
export async function checkProof(
  deps: VerificationDependencies,
  origin: string,
  token: string,
): Promise<VerificationResult> {
  const meta = await checkHtmlMeta(deps, origin, token);
  if (meta.verified) return meta;

  const dns = await checkDnsTxt(deps, origin, token);
  if (dns.verified) return dns;

  // Report the HTML failure, not the DNS one: the meta tag is the method most
  // customers will have used, and "we could not find the tag" is more
  // actionable than "there is no TXT record" to someone who never made one.
  return meta;
}

async function checkHtmlMeta(
  deps: VerificationDependencies,
  origin: string,
  token: string,
): Promise<VerificationResult> {
  const outcome = await safeFetch(deps.network, `${origin}/`, {
    acceptContentTypes: ['text/html', 'application/xhtml+xml'],
    // A homepage that needs more than this is not one we can verify against.
    limits: { maxCompressedBytes: 1024 * 1024, maxRedirects: 3 },
    headers: { 'user-agent': VERIFICATION_USER_AGENT },
  });

  if (!outcome.ok) {
    if (outcome.failure === 'ssrf_blocked') return { verified: false, failure: 'blocked' };
    if (outcome.failure === 'unsupported_content_type') {
      return { verified: false, failure: 'not_html' };
    }
    return { verified: false, failure: 'unreachable' };
  }

  const html = outcome.body.toString('utf8');
  const found = findMetaToken(html);

  if (found === null) return { verified: false, failure: 'token_absent' };
  // ⚠️ A CONSTANT-TIME COMPARISON IS NOT NEEDED AND WOULD BE THEATRE. Both
  // values are public by design, and there is no secret to leak by timing.
  if (found !== token) return { verified: false, failure: 'token_mismatch' };

  return { verified: true, method: 'html_meta' };
}

/** Growth OS identifies itself even when it is only checking a tag. */
export const VERIFICATION_USER_AGENT =
  'GrowthOSBot/1.0 (+https://growth-os.test/bot; site verification)';

/**
 * Find the verification token in a document.
 *
 * ⚠️ A DELIBERATELY NARROW MATCH, not an HTML parse.
 *
 * The full extractor lives in `@growth-os/crawler`, and importing it here would
 * make `@growth-os/sites` depend on the crawler — the exact cycle the package
 * split exists to avoid. What is needed is one attribute pair, and the pattern
 * is anchored tightly enough that it cannot match prose: the tag, the exact
 * name, and 32 hex characters.
 *
 * A false NEGATIVE (an unusual spelling we fail to match) costs an operator a
 * support call. A false POSITIVE would let a page that merely mentions the
 * string verify a domain, so the pattern errs towards strictness.
 */
export function findMetaToken(html: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]*\\bname\\s*=\\s*["']?${VERIFICATION_META_NAME}["']?[^>]*\\bcontent\\s*=\\s*["']?([0-9a-fA-F]{32})["']?`,
    'i',
  );
  const reversed = new RegExp(
    `<meta[^>]*\\bcontent\\s*=\\s*["']?([0-9a-fA-F]{32})["']?[^>]*\\bname\\s*=\\s*["']?${VERIFICATION_META_NAME}["']?`,
    'i',
  );

  const match = pattern.exec(html) ?? reversed.exec(html);
  return match?.[1]?.toLowerCase() ?? null;
}

async function checkDnsTxt(
  deps: VerificationDependencies,
  origin: string,
  token: string,
): Promise<VerificationResult> {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return { verified: false, failure: 'dns_no_record' };
  }

  let records: string[][];
  try {
    records = await deps.txt.resolveTxt(`${VERIFICATION_DNS_LABEL}.${host}`);
  } catch {
    return { verified: false, failure: 'dns_no_record' };
  }

  // A TXT record arrives as an array of strings that the resolver may have
  // split at 255-byte boundaries; joining is what the DNS spec asks for.
  const expected = `${VERIFICATION_META_NAME}=${token}`;
  for (const chunks of records) {
    const value = chunks.join('').trim();
    if (value === expected || value === token) return { verified: true, method: 'dns_txt' };
  }

  return { verified: false, failure: 'dns_no_record' };
}

/**
 * Is this site crawlable?
 *
 * ⚠️ THE ONE FUNCTION THE CRAWLER ASKS. Kept here, beside the code that sets
 * the state, so the rule cannot drift into "the crawler decided it was fine".
 */
export function isCrawlable(site: {
  readonly verificationState: string;
  readonly status: string;
}): boolean {
  return site.verificationState === 'verified' && site.status === 'active';
}
