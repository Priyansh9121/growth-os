/**
 * robots.txt — parsing and evaluation, per RFC 9309.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Answer one question: **may GrowthOSBot fetch this URL?** — and say which rule
 * decided it.
 *
 * ⚠️ THIS IS A PERMISSION CONTROL, NOT A HEURISTIC.
 * A bug here means Growth OS fetches something a site owner explicitly told it
 * not to. That is a broken promise to a customer's customer, made from our
 * addresses with our name in the user agent. Every ambiguity below resolves
 * toward *not fetching*.
 *
 * ⚠️ IT REPORTS THE DECIDING RULE, NEVER A JUDGEMENT.
 * `{ allowed: false, rule: 'Disallow: /admin' }` is a fact. "This site is
 * over-restrictive" is a finding and belongs to a later stage (AGENTS.md §5).
 * The reason is reportable so an operator asking "why was this page skipped?"
 * gets the line from their own file rather than a shrug.
 *
 * ⚠️ NO REGULAR EXPRESSIONS FOR PATTERN MATCHING.
 * A robots.txt is attacker-controlled input. `/a*a*a*a*a*a*a*b` compiled to a
 * regex and run against a long path is catastrophic backtracking — a denial of
 * service delivered by a text file. The matcher below is an explicit two-pointer
 * scan with a single backtrack position, which cannot blow up.
 *
 * @see docs/decisions/ADR-0035-robots-and-politeness.md
 */

/** The product token Growth OS identifies itself by. One definition. */
export const USER_AGENT_TOKEN = 'GrowthOSBot';

/**
 * The full `User-Agent` header sent with every crawler request.
 *
 * Carries a URL so an operator who sees us in their logs can find out what we
 * are and how to stop us, which is the entire social contract of running a bot.
 */
export const USER_AGENT_STRING = `${USER_AGENT_TOKEN}/1.0 (+https://growth-os.test/bot)`;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface RobotsLimits {
  /** Bytes parsed. Google's documented ceiling is 500 KiB; matching it is the
   *  least surprising choice for a site owner who tested against Google. */
  readonly maxBytes: number;
  /** Lines examined, so a file of 10 million blank lines is bounded. */
  readonly maxLines: number;
  /** Rules retained across all groups. */
  readonly maxRules: number;
  /** A single pattern's length. Longer is truncated, not rejected. */
  readonly maxPatternLength: number;
}

export const DEFAULT_ROBOTS_LIMITS: RobotsLimits = {
  maxBytes: 512_000,
  maxLines: 100_000,
  maxRules: 2_000,
  maxPatternLength: 2_048,
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RobotsRule {
  readonly allow: boolean;
  /** The pattern as written, after trimming. Reported to the operator verbatim. */
  readonly pattern: string;
}

export interface RobotsGroup {
  /** Lowercased product tokens this group applies to. */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /**
   * `Crawl-delay`, in seconds, if the group declared one.
   *
   * ⚠️ PARSED HERE, ENFORCED ELSEWHERE. It is not part of RFC 9309 — it is a
   * widely-honoured extension — so this module records what the file said and
   * makes no attempt to apply it. The host scheduler decides what to do with
   * it, and ADR-0035 records that decision. Inventing enforcement here would
   * bury a politeness policy inside a parser.
   */
  readonly crawlDelaySeconds: number | null;
}

export interface RobotsRules {
  readonly groups: readonly RobotsGroup[];
  /** `Sitemap:` values, verbatim and unresolved. Global, not per-group. */
  readonly sitemaps: readonly string[];
  /** True when a limit stopped parsing. The caller decides what that means. */
  readonly truncated: boolean;
}

/** Empty rules — everything is permitted. The shape returned for a 404. */
export const ALLOW_ALL: RobotsRules = { groups: [], sitemaps: [], truncated: false };

/**
 * Why a URL was allowed or refused.
 *
 * A closed set, because these are counted and shown. Each names the RFC 9309
 * clause that produced it.
 */
export type RobotsReason =
  | 'no_group_matched'
  | 'no_rule_matched'
  | 'longest_match'
  | 'allow_wins_tie'
  | 'empty_disallow'
  | 'unparseable_url';

export interface RobotsVerdict {
  readonly allowed: boolean;
  /** The deciding line, as the site wrote it. Null when no rule decided. */
  readonly rule: string | null;
  readonly reason: RobotsReason;
  /** The group's crawl-delay, if it declared one. */
  readonly crawlDelaySeconds: number | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a robots.txt body.
 *
 * Never throws. A file that is malformed, truncated, binary or empty produces
 * rules rather than an exception — the caller's failure mode for "I could not
 * understand this" is decided in `fetch.ts`, not by an exception escaping here.
 */
export function parseRobotsTxt(
  text: string,
  limits: RobotsLimits = DEFAULT_ROBOTS_LIMITS,
): RobotsRules {
  let truncated = false;

  let body = text;
  if (body.length > limits.maxBytes) {
    body = body.slice(0, limits.maxBytes);
    truncated = true;
  }

  // A UTF-8 BOM survives decoding and would become part of the first field
  // name, so `user-agent` stops matching and the first group is silently
  // discarded — turning a restrictive file into a permissive one.
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

  // CRLF, LF and lone CR. Old files and hand-edited ones use all three.
  const lines = body.split(/\r\n|\r|\n/);
  if (lines.length > limits.maxLines) {
    lines.length = limits.maxLines;
    truncated = true;
  }

  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelay: number | null = null;
  /**
   * ⚠️ GROUP MERGING HINGES ON THIS FLAG.
   *
   * Consecutive `User-agent` lines with no rules between them form ONE group
   * (RFC 9309 §2.2.1). A `User-agent` line appearing AFTER a rule starts a new
   * group. Without the distinction, `User-agent: a` / `User-agent: b` /
   * `Disallow: /x` becomes two groups and `b` gets no rules.
   */
  let seenRuleInGroup = false;
  let ruleCount = 0;

  const flush = (): void => {
    if (agents.length > 0) {
      groups.push({ agents, rules, crawlDelaySeconds: crawlDelay });
    }
    agents = [];
    rules = [];
    crawlDelay = null;
    seenRuleInGroup = false;
  };

  for (const raw of lines) {
    // A comment runs to end of line and may follow a value.
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (line.length === 0) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue; // Not a directive. Ignored, never an error.

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (field) {
      case 'user-agent':
      case 'useragent': {
        if (seenRuleInGroup) flush();
        if (value.length > 0) agents.push(value.toLowerCase());
        break;
      }

      case 'allow':
      case 'disallow': {
        // A rule with no preceding user-agent belongs to no group and is
        // dropped — RFC 9309 has no notion of a global rule.
        if (agents.length === 0) break;
        seenRuleInGroup = true;
        if (ruleCount >= limits.maxRules) {
          truncated = true;
          break;
        }
        ruleCount += 1;
        const pattern =
          value.length > limits.maxPatternLength ? value.slice(0, limits.maxPatternLength) : value;
        rules.push({ allow: field === 'allow', pattern });
        break;
      }

      case 'crawl-delay': {
        if (agents.length === 0) break;
        seenRuleInGroup = true;
        // `Number('')` is 0, so an empty value would invent a zero delay.
        const seconds = value.length === 0 ? Number.NaN : Number(value);
        // Ignored rather than clamped when absurd. A file saying `Crawl-delay:
        // banana` has told us nothing, and inventing a number from it would be
        // a policy decision made by a parse failure.
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) {
          crawlDelay = seconds;
        }
        break;
      }

      case 'sitemap': {
        // ⚠️ GLOBAL, and collected regardless of which group is in scope
        // (RFC 9309 §2.2.3). Returned verbatim: resolving, normalising and
        // admitting it belong to `normaliseUrl` and `@growth-os/net`, and a
        // sitemap URL is not trusted merely because robots.txt named it.
        if (value.length > 0 && value.length <= limits.maxPatternLength) sitemaps.push(value);
        break;
      }

      default:
        break; // Unknown directives are ignored, not errors.
    }
  }

  flush();
  return { groups, sitemaps, truncated };
}

// ---------------------------------------------------------------------------
// Group selection
// ---------------------------------------------------------------------------

/**
 * The group that applies to us.
 *
 * ⚠️ EXACT TOKEN MATCH, THEN `*`. Not substring matching.
 *
 * Substring matching is what lets `User-agent: Bot` capture every crawler with
 * "bot" in its name, and it cuts the other way too: a site disallowing
 * `SomeOtherGrowthBot` would silently capture us. An exact token comparison
 * means a site's rules apply to exactly the crawler they name.
 *
 * When several groups name us — legal, and it happens with generated files —
 * the longest agent string wins, then the earliest. Deterministic either way.
 */
export function selectGroup(
  rules: RobotsRules,
  userAgent: string = USER_AGENT_TOKEN,
): RobotsGroup | null {
  const token = userAgent.toLowerCase();

  let specific: RobotsGroup | null = null;
  let specificLength = -1;
  let wildcard: RobotsGroup | null = null;

  for (const group of rules.groups) {
    for (const agent of group.agents) {
      if (agent === token && agent.length > specificLength) {
        specific = group;
        specificLength = agent.length;
      } else if (agent === '*' && wildcard === null) {
        wildcard = group;
      }
    }
  }

  return specific ?? wildcard;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * May we fetch this URL?
 *
 * Matched against the **path and query**, which is what RFC 9309 §2.2.2
 * specifies — `Disallow: /search?q=` is a real and common rule that a
 * path-only matcher would never fire.
 */
export function isAllowed(
  rules: RobotsRules,
  normalisedUrl: string,
  userAgent: string = USER_AGENT_TOKEN,
): RobotsVerdict {
  let target: string;
  try {
    const url = new URL(normalisedUrl);
    target = `${url.pathname}${url.search}`;
  } catch {
    // Not a URL we can evaluate. Refused: an unparseable target is not
    // evidence of permission.
    return { allowed: false, rule: null, reason: 'unparseable_url', crawlDelaySeconds: null };
  }

  const group = selectGroup(rules, userAgent);
  if (!group) {
    // No group named us and there is no `*`. RFC 9309: everything is allowed.
    return { allowed: true, rule: null, reason: 'no_group_matched', crawlDelaySeconds: null };
  }

  const delay = group.crawlDelaySeconds;

  let best: RobotsRule | null = null;
  let bestLength = -1;
  let tie = false;

  for (const rule of group.rules) {
    // ⚠️ `Disallow:` WITH AN EMPTY VALUE MEANS ALLOW EVERYTHING, and is the
    // idiomatic way to write a permissive file. Treating it as a zero-length
    // pattern matching every path would invert the file's meaning entirely.
    if (rule.pattern.length === 0) {
      if (!rule.allow) continue;
      continue;
    }

    if (!matchesPattern(rule.pattern, target)) continue;

    // RFC 9309 §2.2.2: the LONGEST matching pattern wins, regardless of the
    // order rules appear in. On an exact tie, ALLOW wins.
    const length = effectiveLength(rule.pattern);
    if (length > bestLength) {
      best = rule;
      bestLength = length;
      tie = false;
    } else if (length === bestLength && best && rule.allow !== best.allow) {
      tie = true;
      if (rule.allow) best = rule;
    }
  }

  if (!best) {
    // A group applied but nothing in it matched. Everything not disallowed is
    // allowed — and an empty `Disallow:` reaches here too, which is why it is
    // reported distinctly.
    const permissive = group.rules.some((rule) => !rule.allow && rule.pattern.length === 0);
    return {
      allowed: true,
      rule: permissive ? 'Disallow:' : null,
      reason: permissive ? 'empty_disallow' : 'no_rule_matched',
      crawlDelaySeconds: delay,
    };
  }

  return {
    allowed: best.allow,
    rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}`,
    reason: tie ? 'allow_wins_tie' : 'longest_match',
    crawlDelaySeconds: delay,
  };
}

/**
 * A pattern's length for precedence, with `$` not counted.
 *
 * `$` anchors; it is not a character of the path being matched, and counting it
 * would make `/a$` beat `/ab` for a two-character path.
 */
function effectiveLength(pattern: string): number {
  return pattern.endsWith('$') ? pattern.length - 1 : pattern.length;
}

/**
 * Glob matching with exactly two metacharacters: `*` and a trailing `$`.
 *
 * ⚠️ AN EXPLICIT TWO-POINTER SCAN, NOT A REGULAR EXPRESSION.
 *
 * robots.txt is attacker-controlled. `/a*a*a*a*a*a*a*a*a*b` compiled to a regex
 * and matched against a long path is catastrophic backtracking — a denial of
 * service delivered as a text file, and the crawler is the thing that fetched
 * it. This algorithm keeps a single backtrack position and advances
 * monotonically, so its cost is bounded by pattern × path with no exponential
 * case.
 *
 * Everything other than `*` and a trailing `$` is a literal, including `?`,
 * `.` and `[` — which is why regex is wrong twice over: it would also give
 * those characters meanings robots.txt does not give them.
 */
export function matchesPattern(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith('$');

  // ⚠️ AN UNANCHORED PATTERN IS A PREFIX MATCH: `Disallow: /admin` covers
  // `/admin/users`. Appending a `*` turns that into an ordinary full match, so
  // one algorithm serves both cases — and the prefix rule is stated once, here,
  // rather than smeared through the loop's exit conditions.
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`;

  let p = 0;
  let t = 0;
  let starPattern = -1;
  let starTarget = 0;

  while (t < target.length) {
    if (p < glob.length && glob[p] === '*') {
      // Remember where to resume if the rest fails, then try consuming nothing.
      starPattern = p;
      starTarget = t;
      p += 1;
    } else if (p < glob.length && glob[p] === target[t]) {
      p += 1;
      t += 1;
    } else if (starPattern !== -1) {
      // Backtrack: let the last `*` swallow one more character. `starTarget`
      // only ever advances, which is what bounds the whole scan.
      p = starPattern + 1;
      starTarget += 1;
      t = starTarget;
    } else {
      return false;
    }
  }

  // Trailing stars may match the empty remainder.
  while (p < glob.length && glob[p] === '*') p += 1;

  return p === glob.length;
}
