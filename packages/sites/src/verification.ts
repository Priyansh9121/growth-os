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
import { Parser } from 'htmlparser2';
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
    // ⚠️ BOTH TIERS ARE STATED, AND THAT IS THE POINT. This used to name only
    // `maxCompressedBytes`, so `maxDecompressedBytes` merged in from
    // `DEFAULT_LIMITS` at 8 MB — and ADR-0037's timing argument was written
    // against "the caller accepts 1 MB bodies", which was never true after
    // decompression.
    //
    // Overriding one tier and inheriting the other does not just change a
    // number, it changes the RATIO between them: the default pair is 2 MB to
    // 8 MB, so tightening the wire cap to 1 MB while inheriting 8 MB left this
    // call site permitting 8x expansion where the default permits 4x — looser
    // than the default, at the call site that deliberately asked to be tighter.
    // 8 MB of ordinary markup gzips to 24 KB, so that ratio is what an origin
    // actually spends to fill the parser.
    //
    // ⚠️ Not a timing fix. Re-measured: the parse is linear and costs ~96 ms at
    // 8 MB against the ~20,000 ms the old regex cost at 1.12 MB, so ADR-0037's
    // argument survives the real ceiling with room to spare. This is about the
    // call site stating what it accepts instead of half-stating it.
    //
    // @see docs/decisions/ADR-0048-verification-body-ceiling.md
    limits: {
      maxCompressedBytes: 1024 * 1024,
      maxDecompressedBytes: 4 * 1024 * 1024,
      maxRedirects: 3,
    },
    headers: { 'user-agent': VERIFICATION_USER_AGENT },
  });

  if (!outcome.ok) {
    if (outcome.failure === 'ssrf_blocked') return { verified: false, failure: 'blocked' };
    if (outcome.failure === 'unsupported_content_type') {
      return { verified: false, failure: 'not_html' };
    }
    return { verified: false, failure: 'unreachable' };
  }

  const published = findMetaTokens(outcome.body.toString('utf8'));

  if (published.length === 0) return { verified: false, failure: 'token_absent' };

  // ⚠️ ANY published token may be the right one — a THIRD behaviour change.
  //
  // The regex returned the FIRST match, so a page carrying a stale token
  // followed by the current one failed verification while visibly displaying
  // the correct proof. Rotation makes exactly that page normal.
  //
  // A constant-time comparison is not needed and would be theatre: both values
  // are public by design, so there is no secret to leak by timing.
  if (!published.includes(token)) return { verified: false, failure: 'token_mismatch' };

  return { verified: true, method: 'html_meta' };
}

/** Growth OS identifies itself even when it is only checking a tag. */
export const VERIFICATION_USER_AGENT =
  'GrowthOSBot/1.0 (+https://growth-os.test/bot; site verification)';

/**
 * Find every verification token published in a document's `<head>`.
 *
 * ⚠️ THIS IS A STRUCTURAL PARSE, AND THE PREVIOUS VERSION WAS A REGEX OVER RAW
 * HTML. THAT REGEX WAS A VULNERABILITY IN THE CRAWL PERMISSION BOUNDARY.
 *
 * A pattern over text has no notion of document structure, so it cannot tell a
 * real `<meta>` element from a string that looks like one. Measured against the
 * old implementation, thirty-two distinct inputs returned a token that no
 * browser would consider a published tag — a token inside an HTML comment, a
 * `<script>` string, a `<textarea>`, a `<template>`, after `</html>`, in an
 * unrelated element's attribute, and under a *longer* meta name
 * (`growth-os-verification-other`) because the closing quote was optional.
 *
 * The worst of them needed no HTML-injection flaw at all. The payload
 * `name=growth-os-verification content=<token>` contains no `<`, `>`, `"` or
 * `'`, so it survives HTML escaping byte-for-byte — which means any homepage
 * that reflects a search term into its `<meta name="description">` or Open Graph
 * tags could be made to verify a domain the requester does not own.
 *
 * It also backtracked quadratically: 88 ms at 70 KB, 5,973 ms at 560 KB, against
 * a caller that accepts 1 MB. A page the requester chose could block the
 * verification worker for roughly twenty seconds per attempt.
 *
 * A parser fixes all three at once, because the questions it answers are the
 * ones that actually matter: is this an element, what is its tag name, what are
 * its attributes, and where in the document is it.
 *
 * @see docs/decisions/ADR-0037-structural-verification-matching.md
 */

/**
 * Containers whose contents are not the live document.
 *
 * `<template>` is inert markup; `<svg>` and `<math>` are foreign content with
 * their own element namespaces. A `<meta>` inside any of them is not a published
 * tag, and `<template>` in particular defeats the `<head>` restriction on its
 * own — which is why it needs naming rather than relying on position.
 *
 * ⚠️ `<script>`, `<style>` and `<textarea>` are deliberately ABSENT: the parser
 * already treats their contents as raw text, so no element is ever reported
 * inside them. Listing them would suggest the protection comes from this set
 * when it comes from the tokenizer. Asserted by test either way.
 */
const INERT_CONTAINERS = new Set(['template', 'svg', 'math']);

/** A published token: exactly 32 hex characters, nothing else. */
const TOKEN_SHAPE = /^[0-9a-f]{32}$/i;

export function findMetaTokens(html: string): readonly string[] {
  const tokens: string[] = [];
  let headDepth = 0;
  let inertDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === 'head') headDepth += 1;
        if (INERT_CONTAINERS.has(name)) inertDepth += 1;

        // ⚠️ `<head>` ONLY. This is a TIGHTENING over the regex, which matched
        // anywhere in the response. `<head>` is where the instructions tell the
        // operator to put the tag, and body content is far more likely to be
        // user-generated — a comment, a review, a search echo (ADR-0037).
        if (headDepth === 0 || inertDepth > 0) return;

        // The tag name, exactly. Not a prefix: `<metadata>` inside SVG and any
        // `<meta-*>` custom element both matched the old pattern.
        if (name !== 'meta') return;

        // The attribute name, exactly. `data-name` and `xml:name` both satisfied
        // the old `\bname` because `-` and `:` are word boundaries.
        const metaName = attributes['name'];
        if (metaName === undefined) return;
        if (metaName.trim().toLowerCase() !== VERIFICATION_META_NAME) return;

        const content = attributes['content'];
        if (content === undefined) return;

        // ⚠️ TRIMMING IS NEW, and it is a LOOSENING. `content=" TOKEN "`
        // previously returned null. CMS fields pad whitespace, and the token
        // must still be exactly right, so this removes a support call without
        // widening what is accepted (ADR-0037).
        const trimmed = content.trim();
        if (!TOKEN_SHAPE.test(trimmed)) return;

        tokens.push(trimmed.toLowerCase());
      },

      onclosetag(name) {
        if (name === 'head' && headDepth > 0) headDepth -= 1;
        if (INERT_CONTAINERS.has(name) && inertDepth > 0) inertDepth -= 1;
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );

  parser.write(html);
  parser.end();

  return tokens;
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
