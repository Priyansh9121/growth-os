/**
 * Crawl scope — what belongs to the site, and what merely links to it.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One question: **may the crawler fetch this URL as part of this site's crawl?**
 *
 * Separate from `admitUrl` (may we fetch it at all — a security question) and
 * from `normaliseUrl` (is it the same page — an identity question). This one is
 * a **product** question, and the answer is a customer's property boundary.
 *
 * ⚠️ THE DEFAULT IS THE EXACT VERIFIED ORIGIN, AND NOTHING ELSE.
 *
 * Not the registrable domain, not `*.example.com`, not "anything that looks
 * related". A crawler that expands its own scope is a crawler that fetches
 * somebody else's website at volume on a customer's say-so, and the fact that
 * `blog.example.com` usually belongs to the owner of `example.com` is not a
 * fact — on `wordpress.com`, `myshopify.com` or `github.io` it is emphatically
 * false, and those are exactly the hosts small businesses use.
 *
 * @see docs/decisions/ADR-0033-url-normalisation.md — scope, and the three
 *   questions it must not be confused with
 */

export type ScopeVerdict = 'in_scope' | 'external' | 'other_subdomain' | 'scheme_upgrade';

export interface CrawlScope {
  /** The verified origin, normalised. `https://www.example.test`. */
  readonly origin: string;
  /**
   * Also crawl the same host over the other scheme.
   *
   * ⚠️ NARROW AND DELIBERATE: `http://example.test` → `https://example.test`
   * only. It exists because almost every site redirects http to https, and
   * without it the very first fetch of an `http://` site leaves scope on hop
   * one. The host must match exactly; this is not a general relaxation.
   */
  readonly followSchemeUpgrade: boolean;
}

export function crawlScope(origin: string, followSchemeUpgrade = true): CrawlScope {
  return { origin, followSchemeUpgrade };
}

/**
 * Classify a normalised URL against a scope.
 *
 * Returns a REASON rather than a boolean, because the three ways of being out
 * of scope are three different facts about a site. "412 external links" and
 * "38 links to a subdomain you have not verified" are separately useful; "450
 * links we did not follow" is not.
 */
export function classifyScope(normalisedUrl: string, scope: CrawlScope): ScopeVerdict {
  let url: URL;
  let base: URL;
  try {
    url = new URL(normalisedUrl);
    base = new URL(scope.origin);
  } catch {
    return 'external';
  }

  if (url.origin === base.origin) return 'in_scope';

  if (
    scope.followSchemeUpgrade &&
    url.hostname === base.hostname &&
    url.port === base.port &&
    base.protocol === 'http:' &&
    url.protocol === 'https:'
  ) {
    return 'scheme_upgrade';
  }

  // ⚠️ A STRICT PARENT/CHILD RELATIONSHIP ONLY, and this is a deliberate
  // limitation rather than an incomplete check.
  //
  // From scope `https://example.test`, both `www.example.test` and
  // `blog.example.test` are children and report `other_subdomain` — which is
  // the common case, and useful: "your blog is on a host you have not
  // verified" is something an operator can act on.
  //
  // From scope `https://www.example.test`, its SIBLING `blog.example.test`
  // reports `external`. Recognising siblings needs the registrable domain, and
  // the registrable domain needs the Public Suffix List — a dependency that
  // ships a downloaded file which is wrong the moment it goes stale, to answer
  // a question that has no safe wrong answer on `wordpress.com` or `github.io`,
  // where every "sibling" is a different customer.
  //
  // So this reports only what it can prove. Neither verdict is permission:
  // `other_subdomain` is not fetched either.
  const provablyRelated =
    url.hostname === base.hostname ||
    url.hostname.endsWith(`.${base.hostname}`) ||
    base.hostname.endsWith(`.${url.hostname}`);

  return provablyRelated ? 'other_subdomain' : 'external';
}

/** May the crawler fetch this URL for this site? */
export function isFetchable(normalisedUrl: string, scope: CrawlScope): boolean {
  const verdict = classifyScope(normalisedUrl, scope);
  return verdict === 'in_scope' || verdict === 'scheme_upgrade';
}

/**
 * A redirect guard for `safeFetch`, closed over a scope.
 *
 * ⚠️ A REDIRECT OUT OF SCOPE IS REFUSED, NOT FOLLOWED-AND-DISCARDED.
 * Following it first would mean the crawler makes a request to a third party's
 * server, which is the behaviour scope exists to prevent — the fact that we
 * then throw the response away is no comfort to whoever received the traffic.
 */
export function redirectGuard(scope: CrawlScope): (from: URL, to: URL) => boolean {
  return (_from, to) => isFetchable(to.toString(), scope);
}
