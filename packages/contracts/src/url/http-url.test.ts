/**
 * `httpUrlOf` — the one test for "is this an http(s) location?".
 *
 * Mostly hostile input, because the four functions this replaced all agreed on
 * the easy cases and all differed on these. Each block below names the defect
 * it pins, so a future edit that reintroduces one fails with the reason.
 */

import { describe, expect, it } from 'vitest';
import { bareHostOf, httpUrlOf } from './http-url';

/** The shapes a browser or a tracker actually sends. */
const REALISTIC: ReadonlyArray<readonly [string, string]> = [
  ['https://abcplumbing.test', 'https://abcplumbing.test'],
  ['https://www.abcplumbing.test', 'https://www.abcplumbing.test'],
  ['http://abcplumbing.test', 'http://abcplumbing.test'],
  ['https://abcplumbing.test/contact?ref=1', 'https://abcplumbing.test'],
  ['https://abcplumbing.test:8443', 'https://abcplumbing.test:8443'],
  ['https://ABCPLUMBING.TEST', 'https://abcplumbing.test'],
  ['https://sub.domain.abcplumbing.test', 'https://sub.domain.abcplumbing.test'],
  ['http://localhost:3000', 'http://localhost:3000'],
  // A bare authority is the one shape that legitimately has no scheme.
  ['abcplumbing.test', 'https://abcplumbing.test'],
  ['www.abcplumbing.test', 'https://www.abcplumbing.test'],
  ['abcplumbing.test/contact', 'https://abcplumbing.test'],
  ['  https://abcplumbing.test  ', 'https://abcplumbing.test'],
];

describe('httpUrlOf — the shapes that actually arrive', () => {
  it.each(REALISTIC)('%j parses to %j', (input, expected) => {
    expect(httpUrlOf(input)?.origin).toBe(expected);
  });

  it('strips credentials, which a naive string comparison would be fooled by', () => {
    // `https://evil.test@abcplumbing.test` has hostname `abcplumbing.test`.
    expect(httpUrlOf('https://evil.test@abcplumbing.test')?.origin).toBe(
      'https://abcplumbing.test',
    );
  });
});

describe('⚠️ the pattern and the parser disagreed about this text', () => {
  /**
   * `new URL()` removes ASCII tab, LF and CR from anywhere in the string before
   * parsing. `/^https?:\/\//` tested the raw string, said "not absolute", and
   * the caller prepended a scheme to a value that already had one — so the
   * authority became `https`, not `evil.test`.
   */
  it.each([
    ['\thttps://evil.test', 'leading tab'],
    ['\nhttps://evil.test', 'leading LF'],
    ['\rhttps://evil.test', 'leading CR'],
    ['\t\n\rhttps://evil.test', 'all three'],
    ['ht\ttps://evil.test', 'a tab INSIDE the scheme'],
  ])('%j (%s) resolves to the authority a browser resolves it to', (input) => {
    expect(httpUrlOf(input)?.origin).toBe('https://evil.test');
  });

  /**
   * `\` maps to `/` for special schemes, so a browser reads these as
   * `https://evil.test`. The pattern required two forward slashes, so the
   * caller prepended and produced the host `https`.
   */
  it.each([['https:/\\evil.test'], ['https:\\\\evil.test']])(
    '%j maps backslashes the way the parser does',
    (input) => {
      expect(httpUrlOf(input)?.hostname).toBe('evil.test');
    },
  );

  it('never returns the fabricated host "https"', () => {
    for (const input of [
      '\thttps://evil.test',
      'ht\ttps://evil.test',
      'https:/\\evil.test',
      'https:\\\\evil.test',
    ]) {
      expect(httpUrlOf(input)?.hostname, input).not.toBe('https');
    }
  });
});

describe('⚠️ a non-http scheme is refused, never repaired into a host', () => {
  /**
   * Each of these previously became `https://<scheme>` or, worse, borrowed an
   * authority out of the opaque part: `mailto:a@b.test` produced the host
   * `b.test`, which is a real domain nobody linked to.
   */
  it.each([
    ['file:///etc/passwd', 'previously host "file"'],
    ['mailto:a@b.test', 'previously host "b.test"'],
    ['javascript:alert(1)', 'a script URL'],
    ['data:text/html,<b>x</b>', 'an inline document'],
    ['tel:+61400000000', 'a phone number'],
    ['about:blank', 'previously host "about"'],
    ['chrome://settings', 'previously host "chrome"'],
    ['ftp://e.test/x', 'previously host "ftp"'],
    ['vbscript:msgbox(1)', 'a script URL'],
    ['C:\\Windows', 'a Windows path, previously host "c"'],
  ])('%j is null (%s)', (input) => {
    expect(httpUrlOf(input)).toBeNull();
  });

  it('refuses scheme-less host:port rather than guessing which reading was meant', () => {
    // RFC 3986 reads `abcplumbing.test:8080` as the scheme `abcplumbing.test`
    // with the opaque part `8080`. Reading it as a host and a port is a guess.
    // Documented in ADR-0045 and measured in dev log 0026 — it is the only
    // realistic shape this refuses that the previous idiom accepted.
    expect(httpUrlOf('abcplumbing.test:8080')).toBeNull();
    expect(httpUrlOf('localhost:3000')).toBeNull();
  });
});

describe('⚠️ a path is not an authority', () => {
  it('does not manufacture a host out of a rooted path', () => {
    // `'https://' + '/contact'` parses as the origin `https://contact`, which
    // is why `normaliseOrigin`'s "never a repaired guess" was false as written.
    expect(httpUrlOf('/contact')).toBeNull();
    expect(httpUrlOf('/')).toBeNull();
  });

  it('refuses a protocol-relative reference rather than choosing its scheme', () => {
    expect(httpUrlOf('//evil.test/x')).toBeNull();
  });
});

describe('httpUrlOf — nothing parseable', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['\t\n\r', 'only the characters the parser strips'],
    ['::::', 'garbage'],
    ['https://', 'a scheme with no authority'],
    ['http://', 'a scheme with no authority'],
  ])('%j is null (%s)', (input) => {
    expect(httpUrlOf(input)).toBeNull();
  });

  it.each([[null], [undefined]])('%j is null', (input) => {
    expect(httpUrlOf(input)).toBeNull();
  });
});

describe('httpUrlOf — properties, not descriptions', () => {
  const ALL = [
    ...REALISTIC.map(([input]) => input),
    '\thttps://evil.test',
    'https:/\\evil.test',
    'file:///etc/passwd',
    'mailto:a@b.test',
    '/contact',
    '//evil.test/x',
    'abcplumbing.test:8080',
    '::::',
    '',
  ];

  it('anything it returns is http or https — no other scheme escapes', () => {
    for (const input of ALL) {
      const url = httpUrlOf(input);
      if (url !== null) expect(['http:', 'https:'], input).toContain(url.protocol);
    }
  });

  it('anything it returns has a non-empty hostname', () => {
    for (const input of ALL) {
      const url = httpUrlOf(input);
      if (url !== null) expect(url.hostname.length, input).toBeGreaterThan(0);
    }
  });

  it('the characters the parser strips cannot change the answer', () => {
    // The whole defect in one property: inserting a tab, LF or CR anywhere in
    // a value must not change what it resolves to, because the parser removes
    // them before it looks. Any pattern tested against the raw string breaks
    // this, which is how the four copies came to disagree.
    for (const [input] of REALISTIC) {
      const expected = httpUrlOf(input)?.origin ?? null;
      for (const ch of ['\t', '\n', '\r']) {
        expect(httpUrlOf(ch + input)?.origin ?? null, input).toBe(expected);
        expect(httpUrlOf(input + ch)?.origin ?? null, input).toBe(expected);
      }
    }
  });
});

describe('bareHostOf — the shared half of two callers in two packages', () => {
  it.each([
    ['https://www.abcplumbing.test/contact?x=1', 'abcplumbing.test'],
    ['https://abcplumbing.test', 'abcplumbing.test'],
    ['https://WWW.ABCPlumbing.TEST', 'abcplumbing.test'],
    ['abcplumbing.test', 'abcplumbing.test'],
    ['www.abcplumbing.test', 'abcplumbing.test'],
    ['https://sub.abcplumbing.test', 'sub.abcplumbing.test'],
  ])('%j -> %j', (input, expected) => {
    expect(bareHostOf(input)).toBe(expected);
  });

  it('agrees with itself about the www and non-www spelling of one site', () => {
    expect(bareHostOf('https://www.x.test')).toBe(bareHostOf('https://x.test'));
  });

  it('⚠️ strips www where normaliseOrigin must NOT — they answer different questions', () => {
    // To a browser these are different ORIGINS, which is why the origin path
    // keeps the prefix. These callers are matching a SITE, where a customer
    // typing either means the same company.
    expect(bareHostOf('https://www.x.test')).toBe('x.test');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['::::', 'garbage'],
    ['javascript:alert(1)', 'a non-http scheme'],
    ['/contact', 'a path'],
  ])('%j is null (%s)', (input) => {
    expect(bareHostOf(input)).toBeNull();
  });

  it.each([[null], [undefined]])('%j is null', (input) => {
    expect(bareHostOf(input)).toBeNull();
  });

  it('inherits every refusal httpUrlOf makes', () => {
    // Not a restatement: it proves the two are one pipeline, so a tightening in
    // httpUrlOf cannot leave bareHostOf accepting something the parser refused.
    for (const input of ['file:///etc/passwd', 'mailto:a@b.test', 'abcplumbing.test:8080']) {
      expect(httpUrlOf(input), input).toBeNull();
      expect(bareHostOf(input), input).toBeNull();
    }
  });
});
