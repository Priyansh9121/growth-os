/**
 * URL admission policy — the outermost SSRF control.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Decide whether a URL is even a candidate for a network request, before any
 * DNS lookup happens. Everything here is a **syntactic** judgement; the
 * address-level judgement lives in `address/classify.ts` and runs later, at
 * connect time.
 *
 * ⚠️ THE TWO LAYERS ARE NOT REDUNDANT, AND NEITHER IS SUFFICIENT.
 * This layer cannot know where `intranet.example.com` resolves. That layer
 * cannot know that `file:///etc/passwd` was never an HTTP request. A URL must
 * pass both, at every hop, including every redirect.
 *
 * @see docs/security/crawler-ssrf-threat-model.md
 * @see ADR-0032
 */

export type UrlRejection =
  | 'unparseable'
  | 'scheme_not_allowed'
  | 'credentials_present'
  | 'port_not_allowed'
  | 'host_missing'
  | 'host_too_long'
  | 'url_too_long'
  | 'sensitive_query';

export type UrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly rejection: UrlRejection; readonly detail: string };

/**
 * The only two schemes.
 *
 * An allow-list, not a deny-list of `file:`/`gopher:`/`data:`. A deny-list is
 * wrong the first time a runtime learns a new scheme, and Node's URL parser
 * happily parses schemes nobody has heard of.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * The only two ports.
 *
 * ⚠️ A DELIBERATE PRODUCT LIMITATION, not an oversight.
 *
 * Custom ports are how an SSRF payload reaches a service that is not a website:
 * `http://internal.example.com:6379/` for Redis, `:5432` for PostgreSQL,
 * `:9200` for Elasticsearch. Those hosts may well be public — the address
 * classifier would let them through — and the damage comes from the port.
 *
 * The cost is that a customer running their site on `:8443` cannot be crawled.
 * That is a real customer, and the answer is to widen this deliberately, with
 * an ADR, rather than to open the range now for a customer who does not exist
 * yet.
 */
const ALLOWED_PORTS = new Set([80, 443]);

/**
 * Query parameter names that make a URL an authenticated one.
 *
 * ⚠️ THESE URLS ARE NOT FETCHED AT ALL, AND NOT MERELY REDACTED IN LOGS.
 *
 * A URL carrying a session token is a URL somebody was given privately. Two
 * things go wrong if a crawler follows it: the crawler acts with that
 * identity — fetching a password-reset link consumes it — and the resulting
 * page is private content stored under a customer's public site.
 *
 * Redaction alone would fix the log and leave both of those.
 *
 * Matched on the parameter NAME, case-insensitively, as a whole word bounded
 * by common separators, so `token` and `access_token` match while `tokenizer`
 * and `broken` do not.
 */
const SENSITIVE_QUERY_PARAMETERS = [
  // Credential-shaped: fetching one acts with somebody's identity.
  'token',
  'auth',
  'authorization',
  'session',
  'sessionid',
  'jsessionid',
  'phpsessid',
  'sid',
  'password',
  'passwd',
  'pwd',
  'secret',
  'apikey',
  'signature',
  'sig',
  // Single-use-link shaped: fetching one CONSUMES it. A crawler that follows a
  // password-reset link has invalidated a real person's reset.
  'reset',
  'invite',
  'confirm',
  'unsubscribe',
  // PII-shaped: here the harm is not the fetch, it is that the URL becomes a
  // stored `crawl_pages.url` — personal data in a column nobody classifies as
  // personal data, outside erasure's model of where it lives. Same reasoning
  // as the landing-URL truncation in ADR-0028.
  'email',
  'phone',
];

/**
 * ⚠️ DELIBERATELY ABSENT: `code`, `state`, `key`, `id`.
 *
 * Each is credential-shaped in one context and ordinary in another —
 * `?code=SPRING20` is a discount, `?state=VIC` is a region, `?key=colour` is a
 * facet. Refusing them would silently skip large parts of real customer sites,
 * and a crawler that quietly omits pages is worse than one that says so.
 *
 * The line drawn here is "would fetching this act as somebody, consume
 * something, or store personal data?" — not "could this string ever be a
 * secret", which has no answer that terminates.
 */

const SENSITIVE_SET = new Set(SENSITIVE_QUERY_PARAMETERS);

/**
 * Split a parameter name into the words a sensitive match may apply to.
 *
 * `utm_source` → `utm`, `source`, `utm_source`. This is why `sig` matches
 * `?sig=` and `?x-amz-sig=` but not `?design=`.
 */
function parameterWords(name: string): string[] {
  const lower = name.toLowerCase();
  return [lower, ...lower.split(/[-_.[\]]+/).filter(Boolean)];
}

export function isSensitiveParameter(name: string): boolean {
  return parameterWords(name).some((word) => SENSITIVE_SET.has(word));
}

/** A URL longer than this is a generator, not a page. */
const MAX_URL_LENGTH = 2048;
/** Longer than the DNS maximum; nothing beyond it can resolve. */
const MAX_HOST_LENGTH = 253;

/**
 * Admit a URL, or say precisely why not.
 *
 * Accepts a string rather than a `URL` so that parse failures are a rejection
 * with a reason rather than an exception the caller has to remember to catch.
 */
export function admitUrl(input: string): UrlVerdict {
  if (input.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      rejection: 'url_too_long',
      detail: `${input.length} characters exceeds the ${MAX_URL_LENGTH} limit`,
    };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, rejection: 'unparseable', detail: 'Not an absolute URL' };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      rejection: 'scheme_not_allowed',
      detail: `${url.protocol} is not http: or https:`,
    };
  }

  // ⚠️ `https://user:password@example.com/`.
  //
  // Rejected rather than stripped. A crawler that quietly discarded the
  // credentials would fetch a different resource than the URL named, and one
  // that forwarded them would be a credential-relay service reachable by
  // typing a URL into a form.
  //
  // It is also the classic parser-confusion payload: `https://evil.test@10.0.0.1/`
  // reads as `evil.test` to a human and resolves to `10.0.0.1`.
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      rejection: 'credentials_present',
      detail: 'The URL embeds credentials',
    };
  }

  if (url.hostname.length === 0) {
    return { ok: false, rejection: 'host_missing', detail: 'No host' };
  }
  if (url.hostname.length > MAX_HOST_LENGTH) {
    return { ok: false, rejection: 'host_too_long', detail: 'Host exceeds the DNS length limit' };
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) {
    return {
      ok: false,
      rejection: 'port_not_allowed',
      detail: `Port ${port} is not 80 or 443`,
    };
  }

  for (const name of url.searchParams.keys()) {
    if (isSensitiveParameter(name)) {
      return {
        ok: false,
        rejection: 'sensitive_query',
        // ⚠️ The NAME, never the value. The whole point of refusing this URL is
        // that its query string is a secret.
        detail: `Query parameter "${name}" suggests an authenticated URL`,
      };
    }
  }

  return { ok: true, url };
}

/**
 * The host, without the brackets an IPv6 literal carries in `URL.hostname`,
 * and without a root-zone trailing dot.
 *
 * `new URL('http://[::1]/').hostname` is the seven characters `[::1]`, which
 * `isIP` rejects — so a classifier fed the raw hostname would call the loopback
 * address "not an IP address" and, in a block-list design, allow it.
 */
export function bareHost(url: URL): string {
  const host = url.hostname;
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;
}

/** The effective port, with the scheme's default made explicit. */
export function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}
