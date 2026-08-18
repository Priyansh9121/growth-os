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
 * scan with a single backtrack position, so it has no exponential case.
 *
 * ⚠️ AND NO EXPONENTIAL CASE IS NOT THE SAME AS BOUNDED.
 * That claim used to end "which cannot blow up". It was too strong. The scan is
 * `O(pattern × target)`, and one pattern at the URL ceiling was measured at
 * **1,049,601 steps** — a polynomial denial of service, arrived at from the
 * opposite direction. Cost is now bounded by an explicit step budget that fails
 * closed; the two-pointer scan is what makes that budget a small number rather
 * than an arbitrary one.
 *
 * ⚠️ AND THE "EVERY AMBIGUITY" CLAIM ABOVE WAS FALSE THREE TIMES.
 * The audit in dev log 0018 found two places where this file failed *open*, and
 * measuring them found a third. A directive missing its colon was ignored, so
 * `Disallow /admin` fetched `/admin/customers`. The byte cap cut the last line
 * mid-value and kept the stump, so `Allow: /private-public-page` became
 * `Allow: /private` and opened a subtree. And two groups naming the same agent
 * were not combined, so a rule in the second was discarded — with a colon on
 * every line, and with the answer depending on file order.
 *
 * None was a subtle bug in the matcher. All three were the parser deciding, in
 * silence, that something it could not read was something it need not obey.
 *
 * @see docs/decisions/ADR-0035-robots-and-politeness.md
 * @see docs/decisions/ADR-0039-robots-matcher-step-budget.md
 * @see docs/decisions/ADR-0040-robots-fail-open-defects.md
 */

import { MAX_URL_LENGTH } from '@growth-os/net';

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

/**
 * How much work one permission question may cost.
 *
 * ⚠️ THESE ARE A SECURITY CONTROL, NOT A PERFORMANCE TUNING KNOB.
 * Both inputs to the matcher are chosen by the site being crawled: it serves the
 * robots.txt, and it links the URLs. Exceeding either budget changes what the
 * crawler is permitted to fetch — see `isAllowed`.
 *
 * @see docs/decisions/ADR-0039-robots-matcher-step-budget.md
 */
export interface RobotsStepBudgets {
  /**
   * Steps one pattern may consume before its match is *unknown*.
   *
   * Measured (ADR-0039): every real-world pattern shape costs under 4,100 steps
   * against a 2,048-character URL — the longest `normaliseUrl` will admit — and
   * the median costs 5. The pathological shape at the same ceiling costs
   * 1,049,601. The line sits at 50,000: **12× above** anything legitimate that
   * was measured, **21× below** the payload it exists to refuse.
   */
  readonly perPattern: number;
  /**
   * Steps one `isAllowed` call may consume across every rule in the group.
   *
   * ⚠️ WITHOUT THIS, `perPattern` BUYS ALMOST NOTHING. The per-rule budget
   * bounds one pattern; the cost of the call is `rules × budget`, and `maxRules`
   * is 2,000. Measured: a per-rule budget alone leaves 20 minutes of blocked
   * event loop per crawl, which is worse than the residual it was meant to fix.
   */
  readonly perEvaluation: number;
}

/**
 * ⚠️ `perEvaluation` IS DERIVED, NOT PICKED.
 *
 * `maxRules × MAX_URL_LENGTH` is what evaluating a maximally large robots.txt
 * against a maximum-length URL costs when **no pattern backtracks
 * pathologically** — the work the algorithm is supposed to do. Everything beyond
 * it is blowup, which is exactly what is being refused.
 *
 * Measured against it: a legitimate 2,000-rule file (the `maxRules` ceiling) at
 * a 2,048-character URL uses **39.8 %** of the allowance. `MAX_URL_LENGTH` is
 * imported rather than restated, for the reason ADR-0038 gives.
 */
export const DEFAULT_STEP_BUDGETS: RobotsStepBudgets = {
  perPattern: 50_000,
  perEvaluation: DEFAULT_ROBOTS_LIMITS.maxRules * MAX_URL_LENGTH,
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
  | 'unparseable_url'
  /**
   * ⚠️ The deciding rule cost more than the step budget, so we never learned
   * whether it matched, and refused rather than guess.
   *
   * Its own reason rather than `longest_match` because an operator asking "why
   * was this page skipped?" would otherwise be told their pattern decided it.
   * It did not; our budget did. `rule` still quotes the pattern verbatim — the
   * fact being reported is that *this line* is the one that costs too much.
   */
  | 'budget_exhausted';

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

/** The first space or tab in `s`, or -1. Two `indexOf` scans, no regex. */
function firstWhitespace(s: string): number {
  const space = s.indexOf(' ');
  const tab = s.indexOf('\t');
  if (space === -1) return tab;
  if (tab === -1) return space;
  return space < tab ? space : tab;
}

/**
 * Split a directive line into its field name and value.
 *
 * ⚠️ A MISSING COLON USED TO FAIL OPEN, WHICH IS THE WRONG DIRECTION.
 *
 * RFC 9309 requires the colon, so ignoring `Disallow /admin` was conformant —
 * and measured (dev log 0018), it meant `/admin/customers` was **fetched**
 * while Googlebot refused it. `User-agent *` was worse: it produced no group at
 * all, so every rule in the file belonged to nothing and the whole file
 * evaluated as `no_group_matched`.
 *
 * ⚠️ WHICH STANDARD WINS, STATED ONCE. Where RFC 9309 and Google's parser
 * disagree, this file follows **whichever refuses more**, because a site owner
 * writes robots.txt to be obeyed and tests it against Google. `maxBytes` is
 * already justified in this file as Google's ceiling, "the least surprising
 * choice for a site owner who tested against Google"; this is the same argument
 * applied to a case where the surprise would be us fetching their admin panel.
 *
 * ⚠️ THE COLON STILL WINS WHEREVER IT APPEARS. Taking the first whitespace
 * instead would turn `Disallow : /admin` — which parses correctly today — into
 * the value `: /admin`, matching nothing. That would be a fail-open introduced
 * by the fail-open fix.
 *
 * ⚠️ AND WHITESPACE SEPARATES ONLY WHEN THE LINE IS EXACTLY TWO TOKENS.
 * Otherwise `Disallow the admin area please` becomes a rule, and so does any
 * sentence someone forgot to comment out. Google's parser has the same
 * restriction for the same reason. A value that legitimately contains a space
 * is therefore never split — the line is ignored instead, which is what it was
 * before.
 *
 * @see docs/decisions/ADR-0040-robots-fail-open-defects.md
 */
function splitDirective(line: string): readonly [field: string, value: string] | null {
  const colon = line.indexOf(':');
  if (colon !== -1) {
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  }

  const space = firstWhitespace(line);
  if (space === -1) return null;

  const value = line.slice(space + 1).trim();
  if (value.length === 0 || firstWhitespace(value) !== -1) return null;

  return [line.slice(0, space).trim().toLowerCase(), value];
}

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

    // ⚠️ THE CUT IS A CHARACTER OFFSET AND THE FILE HAS LINE STRUCTURE.
    //
    // `slice` cannot see where a directive ends, so the last line it leaves is
    // half a directive — and half a directive is a *different* directive.
    // Measured (dev log 0018): a cut inside `Allow: /private-public-page`
    // leaves `Allow: /private`, which ties `Disallow: /private` on effective
    // length, wins the tie because Allow wins ties, and opens the whole
    // subtree. The stump is a rule the site never wrote.
    //
    // So the partial line is discarded. Every rule that survives is one the
    // site wrote in full. ⚠️ This is NOT rejecting the file — ADR-0035 is
    // explicit that a file over the cap is truncated and the rules we read
    // still apply. It is refusing to invent the one rule we did not read.
    //
    // No line break inside the cap means nothing was read to the end of a
    // line, so there is nothing trustworthy to keep.
    const lastBreak = Math.max(body.lastIndexOf('\n'), body.lastIndexOf('\r'));
    body = lastBreak === -1 ? '' : body.slice(0, lastBreak);
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

    const directive = splitDirective(line);
    if (directive === null) continue; // Not a directive. Ignored, never an error.

    const [field, value] = directive;

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

  const namesUs = rules.groups.some((group) => group.agents.includes(token));
  const winner = namesUs ? token : '*';

  const matching = rules.groups.filter((group) => group.agents.includes(winner));
  if (matching.length === 0) return null;

  // ⚠️ EVERY GROUP NAMING THE WINNER, COMBINED — RFC 9309 §2.2.1 requires it,
  // and returning only the first was a fail-open with a colon on every line.
  //
  // Measured: `User-agent: * / Allow: / / User-agent: * / Disallow: /admin`
  // returned the first group alone, so `Disallow: /admin` was discarded and
  // `/admin/customers` was **fetched**. Swapping the two rules refused it — the
  // verdict depended on which duplicate the file happened to list first, which
  // is not a property a permission boundary may have.
  //
  // Repeated groups are ordinary in generated files: a plugin appends a block,
  // a theme appends another, and both write `User-agent: *`.
  return {
    // The token whose rules these are, not the agent lists they came from. One
    // group's `agents` no longer describes a merged view of several.
    agents: [winner],
    rules: matching.flatMap((group) => group.rules),
    crawlDelaySeconds: mergeCrawlDelay(matching),
  };
}

/**
 * The crawl-delay for a set of merged groups: the **longest** any of them
 * declared, or null if none did.
 *
 * ⚠️ THE MAXIMUM, NOT THE FIRST. Duplicated groups declaring different delays
 * is an ambiguity, and ADR-0035 makes the direction unambiguous: `Crawl-delay`
 * may only ever slow us down, never speed us up. Taking whichever came first
 * would let file order decide how hard we hit someone's server.
 */
function mergeCrawlDelay(groups: readonly RobotsGroup[]): number | null {
  let longest: number | null = null;
  for (const group of groups) {
    const declared = group.crawlDelaySeconds;
    if (declared !== null && (longest === null || declared > longest)) longest = declared;
  }
  return longest;
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
  budgets: RobotsStepBudgets = DEFAULT_STEP_BUDGETS,
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
  /** True when the winning rule's match was presumed rather than computed. */
  let bestPresumed = false;

  /**
   * ⚠️ ONE ALLOWANCE FOR THE WHOLE QUESTION, not one per rule.
   *
   * A per-rule budget bounds a pattern; it does not bound a *file*, and a file
   * may hold `maxRules` of them. Sharing the allowance is what makes the answer
   * to "may we fetch this URL?" cost a bounded amount.
   */
  let allowance = budgets.perEvaluation;

  for (const rule of group.rules) {
    // ⚠️ `Disallow:` WITH AN EMPTY VALUE MEANS ALLOW EVERYTHING, and is the
    // idiomatic way to write a permissive file. Treating it as a zero-length
    // pattern matching every path would invert the file's meaning entirely.
    if (rule.pattern.length === 0) {
      if (!rule.allow) continue;
      continue;
    }

    const attempt = matchPattern(
      rule.pattern,
      target,
      Math.max(0, Math.min(budgets.perPattern, allowance)),
    );
    allowance -= attempt.steps;

    // ⚠️ FAIL CLOSED, AND ASYMMETRICALLY. A budget exhaustion is an ambiguity,
    // and this file resolves every ambiguity toward not fetching. So:
    //
    //   an unevaluable DISALLOW is presumed to have MATCHED — we may not fetch
    //   an unevaluable ALLOW    is presumed NOT to have matched — it grants
    //                             nothing, because permission we did not compute
    //                             is not permission
    //
    // Both presumptions push the same way. Dropping an Allow can only ever make
    // the verdict more restrictive, never less, which is what makes the budget
    // safe to add to a permission control at all.
    let presumed = false;
    if (attempt.outcome === 'budget_exhausted') {
      if (rule.allow) continue;
      presumed = true;
    } else if (attempt.outcome === 'no_match') {
      continue;
    }

    // ⚠️ AND PRECEDENCE STILL RUNS. A presumed match competes on length like any
    // other rather than short-circuiting, because that is *more* conservative,
    // not less: a genuine Allow that is longer wins under both readings of the
    // unknown — if the Disallow matched, the longer Allow beats it; if it did
    // not, the Allow wins anyway. Refusing there would refuse a URL whose
    // verdict is actually known. The URL is refused exactly when the two
    // readings disagree.
    //
    // RFC 9309 §2.2.2: the LONGEST matching pattern wins, regardless of the
    // order rules appear in. On an exact tie, ALLOW wins.
    const length = effectiveLength(rule.pattern);
    if (length > bestLength) {
      best = rule;
      bestLength = length;
      tie = false;
      bestPresumed = presumed;
    } else if (length === bestLength && best && rule.allow !== best.allow) {
      tie = true;
      if (rule.allow) {
        best = rule;
        bestPresumed = presumed;
      }
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
    // A presumed match is never an Allow — those are dropped above — so this can
    // only ever report a refusal we could not compute.
    reason: bestPresumed ? 'budget_exhausted' : tie ? 'allow_wins_tie' : 'longest_match',
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
 * What one pattern comparison concluded.
 *
 * ⚠️ THREE OUTCOMES, NOT A BOOLEAN, and that is the whole point: `no_match` and
 * `budget_exhausted` are not the same fact. One says the rule does not apply;
 * the other says we do not know whether it does.
 */
export type PatternMatchOutcome = 'match' | 'no_match' | 'budget_exhausted';

export interface PatternMatchResult {
  readonly outcome: PatternMatchOutcome;
  /** Steps consumed. The caller subtracts this from a shared allowance. */
  readonly steps: number;
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
 * ⚠️ AND `pattern × path` IS STILL TOO MUCH TO PAY.
 *
 * That bound was written down accurately and never multiplied out. At the
 * 2,048-character URL ceiling it is 4.2 million comparisons, and a pattern of
 * the shape `/*` + a literal run half the target's length reaches 1,049,601 of
 * them, because every backtrack re-compares the whole run. `page_limit` permits
 * 10,000 URLs. So `budget` is a hard ceiling on the work, and running out of it
 * is a **third answer** rather than a `false` — see `isAllowed`, which is where
 * not knowing gets resolved.
 *
 * ⚠️ THE BUDGET COUNTS LOOP STEPS, NOT BACKTRACKS. Measured (ADR-0039): the
 * pathological shape takes 49,049 steps and **47** backtracks, while a harmless
 * 500-star pattern takes 2,548 steps and **1,547**. Backtracks are 33× higher
 * on the cheap input, because cost is backtracks × the literal run each one
 * re-compares, and neither factor alone is the bill. Steps track wall clock at a
 * flat ~6 ns across every shape measured; backtracks do not track it at all.
 *
 * Everything other than `*` and a trailing `$` is a literal, including `?`,
 * `.` and `[` — which is why regex is wrong twice over: it would also give
 * those characters meanings robots.txt does not give them.
 *
 * @see docs/decisions/ADR-0039-robots-matcher-step-budget.md
 */
export function matchPattern(
  pattern: string,
  target: string,
  budget: number = DEFAULT_STEP_BUDGETS.perPattern,
): PatternMatchResult {
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
  let steps = 0;

  while (t < target.length) {
    if ((steps += 1) > budget) return { outcome: 'budget_exhausted', steps };
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
      return { outcome: 'no_match', steps };
    }
  }

  // Trailing stars may match the empty remainder. Counted too, so the budget is
  // a bound on the function rather than on most of it.
  while (p < glob.length && glob[p] === '*') {
    if ((steps += 1) > budget) return { outcome: 'budget_exhausted', steps };
    p += 1;
  }

  return { outcome: p === glob.length ? 'match' : 'no_match', steps };
}
