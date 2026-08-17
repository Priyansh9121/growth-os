/**
 * robots.txt parsing and evaluation.
 *
 * WHY THE NEGATIVES DOMINATE
 * This is a permission control. "An allowed URL is allowed" would pass against
 * an implementation that allowed everything, which is exactly the bug that
 * matters — so nearly every case below asserts a REFUSAL, or asserts that a
 * refusal was decided by the rule the site actually wrote.
 *
 * The hostile-input block is not decoration. A robots.txt is fetched from a
 * stranger's server, and the crawler is the thing that asked for it.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALL,
  DEFAULT_ROBOTS_LIMITS,
  isAllowed,
  matchesPattern,
  parseRobotsTxt,
  selectGroup,
  USER_AGENT_TOKEN,
} from './parse';

const url = (path: string): string => `https://example.test${path}`;

/** Allowed/refused for our token, for brevity in tables. */
const allows = (robots: string, path: string, agent = USER_AGENT_TOKEN): boolean =>
  isAllowed(parseRobotsTxt(robots), url(path), agent).allowed;

describe('parseRobotsTxt', () => {
  it('reads a group, its rules and a sitemap', () => {
    const rules = parseRobotsTxt(`
      User-agent: *
      Disallow: /admin
      Allow: /admin/public
      Crawl-delay: 5
      Sitemap: https://example.test/sitemap.xml
    `);

    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]?.agents).toEqual(['*']);
    expect(rules.groups[0]?.rules).toHaveLength(2);
    expect(rules.groups[0]?.crawlDelaySeconds).toBe(5);
    expect(rules.sitemaps).toEqual(['https://example.test/sitemap.xml']);
  });

  describe('group merging', () => {
    it('⚠️ merges consecutive user-agent lines into ONE group', () => {
      // RFC 9309 §2.2.1. Without this, `b` gets no rules at all and a site that
      // carefully named two crawlers has its file silently half-applied.
      const rules = parseRobotsTxt('User-agent: a\nUser-agent: b\nDisallow: /x');

      expect(rules.groups).toHaveLength(1);
      expect(rules.groups[0]?.agents).toEqual(['a', 'b']);
      expect(allows('User-agent: a\nUser-agent: b\nDisallow: /x', '/x', 'b')).toBe(false);
    });

    it('starts a new group when a user-agent follows a rule', () => {
      const rules = parseRobotsTxt('User-agent: a\nDisallow: /x\nUser-agent: b\nDisallow: /y');
      expect(rules.groups).toHaveLength(2);
      expect(allows('User-agent: a\nDisallow: /x\nUser-agent: b\nDisallow: /y', '/y', 'a')).toBe(
        true,
      );
    });

    it('drops rules that precede any user-agent line', () => {
      // RFC 9309 has no global rule. A file starting with a bare `Disallow: /`
      // must not lock out every crawler.
      const rules = parseRobotsTxt('Disallow: /\nUser-agent: *\nAllow: /');
      expect(rules.groups).toHaveLength(1);
      expect(rules.groups[0]?.rules).toHaveLength(1);
      expect(allows('Disallow: /\nUser-agent: *\nAllow: /', '/anything')).toBe(true);
    });
  });

  describe('line handling', () => {
    it.each([
      ['CRLF', 'User-agent: *\r\nDisallow: /x'],
      ['lone CR', 'User-agent: *\rDisallow: /x'],
      ['LF', 'User-agent: *\nDisallow: /x'],
    ])('handles %s line endings', (_label, body) => {
      expect(allows(body, '/x')).toBe(false);
    });

    it('⚠️ strips a UTF-8 BOM', () => {
      // Left in place it becomes part of the first field name, so the first
      // group is discarded and the file reads as permissive.
      expect(allows('﻿User-agent: *\nDisallow: /x', '/x')).toBe(false);
    });

    it('ignores comments, including trailing ones', () => {
      expect(allows('# hello\nUser-agent: * # us\nDisallow: /x # secret', '/x')).toBe(false);
    });

    it('is case-insensitive on field names and agent tokens', () => {
      expect(allows('USER-AGENT: GROWTHOSBOT\nDISALLOW: /x', '/x')).toBe(false);
    });

    it('ignores unknown directives rather than failing', () => {
      expect(
        allows('User-agent: *\nHost: example.test\nRequest-rate: 1/5\nDisallow: /x', '/x'),
      ).toBe(false);
    });

    it('ignores a line with no colon', () => {
      expect(allows('User-agent: *\nthis is not a directive\nDisallow: /x', '/x')).toBe(false);
    });
  });

  describe('crawl-delay', () => {
    it('is recorded, not enforced here', () => {
      const verdict = isAllowed(parseRobotsTxt('User-agent: *\nCrawl-delay: 10'), url('/'));
      expect(verdict.crawlDelaySeconds).toBe(10);
      expect(verdict.allowed).toBe(true);
    });

    it('accepts a fractional delay', () => {
      expect(parseRobotsTxt('User-agent: *\nCrawl-delay: 0.5').groups[0]?.crawlDelaySeconds).toBe(
        0.5,
      );
    });

    it.each(['banana', '-1', '999999', ''])('ignores an unusable value: %s', (value) => {
      // Inventing a number from a parse failure would be a politeness policy
      // decided by a typo.
      expect(
        parseRobotsTxt(`User-agent: *\nCrawl-delay: ${value}`).groups[0]?.crawlDelaySeconds,
      ).toBeNull();
    });
  });

  describe('sitemaps', () => {
    it('collects them regardless of which group is in scope', () => {
      const rules = parseRobotsTxt(
        'Sitemap: https://a.test/s1.xml\nUser-agent: other\nDisallow: /\nSitemap: https://a.test/s2.xml',
      );
      expect(rules.sitemaps).toEqual(['https://a.test/s1.xml', 'https://a.test/s2.xml']);
    });

    it('returns them verbatim, unresolved and unadmitted', () => {
      // Not trusted because robots.txt named them. normaliseUrl and
      // @growth-os/net decide, later.
      const rules = parseRobotsTxt('Sitemap: http://169.254.169.254/sitemap.xml');
      expect(rules.sitemaps).toEqual(['http://169.254.169.254/sitemap.xml']);
    });
  });
});

describe('selectGroup', () => {
  const robots =
    'User-agent: *\nDisallow: /everyone\n\nUser-agent: growthosbot\nDisallow: /just-us';

  it('prefers the group naming our token over the wildcard', () => {
    expect(selectGroup(parseRobotsTxt(robots))?.agents).toEqual(['growthosbot']);
    expect(allows(robots, '/just-us')).toBe(false);
    // ⚠️ The wildcard group does NOT also apply. RFC 9309: the most specific
    // group applies, and only that one.
    expect(allows(robots, '/everyone')).toBe(true);
  });

  it('falls back to the wildcard when nothing names us', () => {
    expect(selectGroup(parseRobotsTxt('User-agent: *\nDisallow: /x'))?.agents).toEqual(['*']);
  });

  it('returns null when no group applies', () => {
    expect(selectGroup(parseRobotsTxt('User-agent: someoneelse\nDisallow: /'))).toBeNull();
  });

  it('⚠️ matches the token exactly, never as a substring', () => {
    // Substring matching would let `User-agent: Bot` capture every crawler, and
    // would let a rule aimed at `NotGrowthOSBotReally` capture us.
    expect(allows('User-agent: bot\nDisallow: /x', '/x')).toBe(true);
    expect(allows('User-agent: growthosbot-news\nDisallow: /x', '/x')).toBe(true);
    expect(allows('User-agent: notgrowthosbot\nDisallow: /x', '/x')).toBe(true);
  });
});

describe('isAllowed — RFC 9309 precedence', () => {
  it('⚠️ the LONGEST match wins, whatever the order', () => {
    // The single most misimplemented rule: first-match-wins is intuitive and
    // wrong, and it inverts this file.
    const robots = 'User-agent: *\nAllow: /docs/public\nDisallow: /docs';
    expect(allows(robots, '/docs/public/x')).toBe(true);
    expect(allows(robots, '/docs/private')).toBe(false);

    const reversed = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public';
    expect(allows(reversed, '/docs/public/x')).toBe(true);
  });

  it('⚠️ ALLOW wins an exact-length tie', () => {
    const verdict = isAllowed(
      parseRobotsTxt('User-agent: *\nDisallow: /page\nAllow: /page'),
      url('/page'),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe('allow_wins_tie');
  });

  it('an empty Disallow permits everything', () => {
    const verdict = isAllowed(parseRobotsTxt('User-agent: *\nDisallow:'), url('/anything'));
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe('empty_disallow');
  });

  it('Disallow: / refuses the whole site including the root', () => {
    expect(allows('User-agent: *\nDisallow: /', '/')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /', '/anything/deep')).toBe(false);
  });

  it('allows everything when the file is empty or has no groups', () => {
    expect(allows('', '/x')).toBe(true);
    expect(allows('# only a comment', '/x')).toBe(true);
    expect(isAllowed(ALLOW_ALL, url('/x')).allowed).toBe(true);
  });

  it('matches against path AND query', () => {
    // `Disallow: /search?q=` is real and common; a path-only matcher never
    // fires on it.
    expect(allows('User-agent: *\nDisallow: /search?q=', '/search?q=shoes')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /search?q=', '/search')).toBe(true);
  });

  it('refuses a URL it cannot parse rather than assuming permission', () => {
    const verdict = isAllowed(parseRobotsTxt('User-agent: *\nDisallow: /x'), 'not a url');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('unparseable_url');
  });

  describe('the deciding rule is reportable', () => {
    it('names the line the site wrote', () => {
      const verdict = isAllowed(
        parseRobotsTxt('User-agent: *\nDisallow: /admin'),
        url('/admin/users'),
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBe('Disallow: /admin');
      expect(verdict.reason).toBe('longest_match');
    });

    it('reports a fact, not a judgement', () => {
      // AGENTS.md §5: the crawler acquires facts. No severity, no advice.
      const verdict = isAllowed(parseRobotsTxt('User-agent: *\nDisallow: /'), url('/x'));
      expect(Object.keys(verdict).sort()).toEqual([
        'allowed',
        'crawlDelaySeconds',
        'reason',
        'rule',
      ]);
    });
  });
});

describe('matchesPattern — the only two metacharacters', () => {
  it.each([
    ['/admin', '/admin', true],
    ['/admin', '/admin/users', true], // unanchored patterns are prefixes
    ['/admin', '/administrator', true], // and prefixes are literal, not segments
    ['/admin', '/user/admin', false],
    ['/*.php', '/index.php', true],
    ['/*.php', '/a/b/c.php', true],
    ['/*.php', '/index.html', false],
    ['/fish*', '/fish.html', true],
    ['/x$', '/x', true],
    ['/x$', '/xy', false],
    ['/*.php$', '/a.php', true],
    ['/*.php$', '/a.php?x=1', false],
    ['/', '/anything', true],
  ])('%s vs %s -> %s', (pattern, target, expected) => {
    expect(matchesPattern(pattern, target)).toBe(expected);
  });

  it('treats regex metacharacters as literals', () => {
    // A regex implementation would give these meanings robots.txt does not.
    expect(matchesPattern('/a.b', '/axb')).toBe(false);
    expect(matchesPattern('/a.b', '/a.b')).toBe(true);
    expect(matchesPattern('/a+b', '/aab')).toBe(false);
    expect(matchesPattern('/[a]', '/[a]')).toBe(true);
    expect(matchesPattern('/a(b)', '/a(b)')).toBe(true);
  });

  it('handles consecutive and trailing stars', () => {
    expect(matchesPattern('/a**b', '/axxb')).toBe(true);
    expect(matchesPattern('/a*', '/a')).toBe(true);
    expect(matchesPattern('/a*$', '/a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 hostile input
// ---------------------------------------------------------------------------

describe('hostile input', () => {
  it('⚠️ a pathological wildcard pattern completes in bounded time', () => {
    // /a*a*a*…*b against a long run of `a` is catastrophic backtracking in any
    // regex engine — a denial of service delivered as a text file, to the
    // process that fetched it. The two-pointer matcher cannot blow up.
    const pattern = `/${'a*'.repeat(24)}b`;
    const target = `/${'a'.repeat(4000)}`;

    const started = Date.now();
    const result = matchesPattern(pattern, target);
    const elapsed = Date.now() - started;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  it('a 10 MB body is truncated rather than parsed whole', () => {
    const huge = `User-agent: *\nDisallow: /x\n${'# padding\n'.repeat(1_000_000)}`;
    expect(huge.length).toBeGreaterThan(10_000_000);

    const rules = parseRobotsTxt(huge);

    expect(rules.truncated).toBe(true);
    // The rules that fit are still honoured — truncation is not permission.
    expect(isAllowed(rules, url('/x')).allowed).toBe(false);
  });

  it('caps the number of rules', () => {
    const many = `User-agent: *\n${Array.from({ length: 50_000 }, (_, i) => `Disallow: /p${i}`).join('\n')}`;
    const rules = parseRobotsTxt(many);

    expect(rules.truncated).toBe(true);
    expect(rules.groups[0]?.rules.length).toBeLessThanOrEqual(DEFAULT_ROBOTS_LIMITS.maxRules);
  });

  it('caps the number of lines', () => {
    const rules = parseRobotsTxt('\n'.repeat(500_000));
    expect(rules.truncated).toBe(true);
  });

  it('truncates an absurdly long single pattern', () => {
    const rules = parseRobotsTxt(`User-agent: *\nDisallow: /${'x'.repeat(100_000)}`);
    expect(rules.groups[0]?.rules[0]?.pattern.length).toBeLessThanOrEqual(
      DEFAULT_ROBOTS_LIMITS.maxPatternLength,
    );
  });

  it('survives 100 KB of wildcards in one pattern', () => {
    const started = Date.now();
    const rules = parseRobotsTxt(`User-agent: *\nDisallow: /${'*'.repeat(100_000)}`);
    isAllowed(rules, url('/some/deep/path?with=query'));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    ['binary noise', '  User-agent: *\nDisallow: /x'],
    ['replacement characters from a bad decode', '��\nUser-agent: *\nDisallow: /x'],
    ['no groups at all', 'Sitemap: https://a.test/s.xml'],
    ['only comments', '#a\n#b\n#c'],
    ['whitespace only', '   \n\t\n  '],
  ])('does not throw on %s', (_label, body) => {
    expect(() => parseRobotsTxt(body)).not.toThrow();
    expect(() => isAllowed(parseRobotsTxt(body), url('/x'))).not.toThrow();
  });

  it('handles unicode and percent-encoded paths', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /caf%C3%A9');
    // normaliseUrl produces percent-encoded paths, so the comparison is
    // encoded-against-encoded.
    expect(isAllowed(rules, url('/caf%C3%A9/menu')).allowed).toBe(false);
  });

  it('a conflicting file still produces a deterministic answer', () => {
    const robots =
      'User-agent: *\nDisallow: /a\nAllow: /a\nDisallow: /a\nAllow: /a\nDisallow: /a/b';
    const first = isAllowed(parseRobotsTxt(robots), url('/a/b'));
    const second = isAllowed(parseRobotsTxt(robots), url('/a/b'));
    expect(first).toEqual(second);
    expect(first.allowed).toBe(false); // /a/b is longer than /a
  });
});

describe('a real-world file', () => {
  // Shaped like what a WordPress site actually serves.
  const robots = `
    User-agent: *
    Disallow: /wp-admin/
    Allow: /wp-admin/admin-ajax.php
    Disallow: /?s=
    Disallow: /search/

    User-agent: AhrefsBot
    Disallow: /

    Sitemap: https://example.test/wp-sitemap.xml
  `;

  it.each([
    ['/wp-admin/options.php', false],
    ['/wp-admin/admin-ajax.php', true],
    ['/search/anything', false],
    ['/?s=plumber', false],
    ['/about', true],
    ['/', true],
  ])('%s -> allowed=%s', (path, expected) => {
    expect(allows(robots, path)).toBe(expected);
  });

  it('does not apply another crawler’s group to us', () => {
    expect(allows(robots, '/')).toBe(true);
    expect(allows(robots, '/', 'AhrefsBot')).toBe(false);
  });

  it('exposes the sitemap for the frontier to seed from', () => {
    expect(parseRobotsTxt(robots).sitemaps).toEqual(['https://example.test/wp-sitemap.xml']);
  });
});
