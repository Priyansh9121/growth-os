/**
 * The pure decisions in the public path.
 *
 * Origin matching, value mapping, title rendering, abuse signals and context
 * sanitisation — each testable without a database, and each a place where
 * getting it wrong is either a security hole or a lost lead.
 *
 * Mostly negatives, because "a valid submission works" would pass even if
 * every check below were absent.
 */

import { describe, expect, it } from 'vitest';
import {
  formVersionConfigSchema,
  splitLandingUrl,
  type FormFieldConfig,
} from '@growth-os/contracts';
import { referrerHost } from '@growth-os/contracts';
import { normaliseWebsiteHost } from '@growth-os/crm';
import { isFirstPartyOrigin, isOriginAllowed, normaliseOrigin } from '@growth-os/sites';
import { evaluateAbuseSignals } from './abuse';
import { honeypotKeyFor } from './honeypot';
import { mapValues, renderTitle } from './submit';
import { sanitiseContext, toOrigin, toPath } from '../tracking/sanitise';

describe('normaliseOrigin', () => {
  it.each([
    ['https://www.abcplumbing.test', 'https://www.abcplumbing.test'],
    ['abcplumbing.test', 'https://abcplumbing.test'],
    ['https://abcplumbing.test/contact?x=1', 'https://abcplumbing.test'],
    ['HTTPS://ABCPlumbing.TEST', 'https://abcplumbing.test'],
    ['https://abcplumbing.test:443', 'https://abcplumbing.test'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ])('normalises %s', (input, expected) => {
    expect(normaliseOrigin(input)).toBe(expected);
  });

  it('strips credentials, which a naive comparison would be fooled by', () => {
    // `https://evil.test@abcplumbing.test` has hostname `abcplumbing.test`.
    // Anything doing string comparison on the raw value gets this wrong.
    expect(normaliseOrigin('https://evil.test@abcplumbing.test')).toBe('https://abcplumbing.test');
  });

  it.each([
    ['', 'empty'],
    ['null', 'the literal a sandboxed frame sends'],
    ['javascript:alert(1)', 'a non-http scheme'],
    ['   ', 'whitespace'],
  ])('returns null for %s (%s)', (input) => {
    expect(normaliseOrigin(input)).toBeNull();
  });

  it('preserves www, because it is a different origin to a browser', () => {
    expect(normaliseOrigin('https://www.x.test')).not.toBe(normaliseOrigin('https://x.test'));
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['https://www.abcplumbing.test'];

  it('permits the configured origin', () => {
    expect(isOriginAllowed('https://www.abcplumbing.test', allowed)).toBe(true);
  });

  it('permits ANY origin when the list is empty', () => {
    // A deliberate open default: a form exists to be embedded on sites we may
    // not know about yet, and the tenancy guarantee never depended on this.
    expect(isOriginAllowed('https://anywhere.test', [])).toBe(true);
  });

  it('refuses a lookalike that suffix matching would let through', () => {
    expect(isOriginAllowed('https://evil-abcplumbing.test', allowed)).toBe(false);
    expect(isOriginAllowed('https://abcplumbing.test.evil.test', allowed)).toBe(false);
  });

  it('refuses a subdomain, because wildcards are not supported', () => {
    // On a platform with user content (`*.wordpress.com`), a subdomain wildcard
    // would permit every other tenant of that platform.
    expect(isOriginAllowed('https://sub.www.abcplumbing.test', allowed)).toBe(false);
  });

  it('refuses a scheme downgrade', () => {
    expect(isOriginAllowed('http://www.abcplumbing.test', allowed)).toBe(false);
  });

  it('refuses an absent origin when a list is configured', () => {
    expect(isOriginAllowed(null, allowed)).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
  });
});

describe('isFirstPartyOrigin', () => {
  it('always permits the application origin', () => {
    // Otherwise configuring an allow-list silently breaks the hosted form and
    // the admin preview — a support call with no obvious cause.
    expect(isFirstPartyOrigin('https://app.growth-os.test', 'https://app.growth-os.test')).toBe(
      true,
    );
  });

  it('does not permit a different origin', () => {
    expect(isFirstPartyOrigin('https://evil.test', 'https://app.growth-os.test')).toBe(false);
  });
});

describe('mapValues', () => {
  const fields = (): FormFieldConfig[] =>
    formVersionConfigSchema.parse({
      fields: [
        { key: 'fname', type: 'text', label: 'First name', required: true, target: 'firstName' },
        { key: 'email', type: 'email', label: 'Email', target: 'email' },
        { key: 'msg', type: 'textarea', label: 'Message', target: 'note', maxLength: 20 },
        {
          key: 'src',
          type: 'select',
          label: 'Heard via',
          options: ['Google', 'Friend'],
          target: 'none',
        },
        { key: 'ignored', type: 'text', label: 'Internal', target: 'none' },
      ],
      settings: {},
    }).fields;

  it('maps values onto CRM identity', () => {
    const result = mapValues(fields(), { fname: 'Priya', email: 'priya@example.test' });

    expect(result.identity).toEqual({ firstName: 'Priya', email: 'priya@example.test' });
  });

  it('IGNORES a key the version does not declare', () => {
    // The version decides, not the payload. A crafted submission cannot
    // introduce a field — the same closed-allow-list rule as CSV import.
    const result = mapValues(fields(), {
      fname: 'Priya',
      email: 'priya@example.test',
      workspace_id: 'attacker-controlled',
      ownerUserId: 'attacker-controlled',
    });

    expect(JSON.stringify(result)).not.toContain('attacker-controlled');
  });

  it('reports a missing required field rather than inventing one', () => {
    expect(mapValues(fields(), { email: 'x@example.test' }).missingRequired).toEqual(['fname']);
  });

  it('refuses a select value the version does not declare', () => {
    // Otherwise a crafted payload writes arbitrary text into a field the
    // operator believes is a controlled vocabulary.
    const result = mapValues(fields(), {
      fname: 'Priya',
      email: 'p@example.test',
      src: 'Something else entirely',
    });

    expect(result.missingRequired).toContain('src');
  });

  it('truncates to the field maxLength', () => {
    const result = mapValues(fields(), {
      fname: 'Priya',
      msg: 'x'.repeat(500),
    });

    // 20 characters, plus the label prefix the note carries.
    expect(result.note).toBe(`Message: ${'x'.repeat(20)}`);
  });

  it('labels note fields, so a multi-field enquiry stays readable', () => {
    const result = mapValues(fields(), { fname: 'Priya', msg: 'Burst pipe' });
    expect(result.note).toBe('Message: Burst pipe');
  });

  it('converts a checked checkbox to a readable value', () => {
    const withCheckbox = formVersionConfigSchema.parse({
      fields: [
        { key: 'fname', type: 'text', label: 'Name', target: 'firstName' },
        { key: 'urgent', type: 'checkbox', label: 'Urgent', target: 'note' },
      ],
      settings: {},
    }).fields;

    expect(mapValues(withCheckbox, { fname: 'Priya', urgent: true }).note).toBe('Urgent: Yes');
  });
});

describe('renderTitle', () => {
  const values = { contact: 'Priya Raman', form: 'Contact us', company: 'ABC Plumbing' };

  it('expands the controlled vocabulary', () => {
    expect(renderTitle('{contact} — {form}', values)).toBe('Priya Raman — Contact us');
  });

  it('does NOT evaluate anything', () => {
    // A template that could evaluate would be remote code execution configured
    // through a web form. These are literal replacements and nothing else.
    const hostile = '${process.env.SESSION_SECRET} {{7*7}} <script>alert(1)</script>';
    const result = renderTitle(hostile, values);

    expect(result).toContain('${process.env.SESSION_SECRET}');
    expect(result).toContain('{{7*7}}');
    expect(result).not.toContain('49');
  });

  it('leaves an unrecognised placeholder literal rather than dropping it', () => {
    // A typo in the template is then visible on the deal, instead of silently
    // producing a title with a gap in it.
    expect(renderTitle('{contact} via {chanel}', values)).toBe('Priya Raman via {chanel}');
  });

  it('falls back when the contact name is empty', () => {
    expect(renderTitle('{contact}', { ...values, contact: '' })).toBe('Website visitor');
  });

  it('bounds the result', () => {
    expect(renderTitle('x'.repeat(500), values).length).toBeLessThanOrEqual(200);
  });
});

describe('evaluateAbuseSignals', () => {
  const base = {
    honeypotEnabled: true,
    honeypotKey: 'website_abcd',
    trap: undefined as string | undefined,
    elapsedMs: 10_000 as number | undefined,
    minSubmitSeconds: 2,
  };

  it('passes a normal submission', () => {
    expect(evaluateAbuseSignals(base)).toBeNull();
  });

  it('catches a filled honeypot', () => {
    expect(evaluateAbuseSignals({ ...base, trap: 'https://spam.test' })).toBe('honeypot');
  });

  it('ignores a whitespace-only honeypot value', () => {
    expect(evaluateAbuseSignals({ ...base, trap: '   ' })).toBeNull();
  });

  it('catches an implausibly fast submission', () => {
    expect(evaluateAbuseSignals({ ...base, elapsedMs: 200 })).toBe('too_fast');
  });

  it('does NOT treat an absent elapsed time as suspicious', () => {
    // The tracking script may legitimately be blocked, and a form must work
    // without it. Rejecting on absence would trade real leads for spam ones.
    expect(evaluateAbuseSignals({ ...base, elapsedMs: undefined })).toBeNull();
  });

  it('does not block a fast autofill when the threshold is 0', () => {
    expect(evaluateAbuseSignals({ ...base, elapsedMs: 50, minSubmitSeconds: 0 })).toBeNull();
  });
});

describe('honeypotKeyFor', () => {
  it('is stable for a version', () => {
    expect(honeypotKeyFor('v1')).toBe(honeypotKeyFor('v1'));
  });

  it('differs between versions', () => {
    // A fixed name across every Growth OS form would be in every spam
    // toolkit's skip-list within a week.
    expect(honeypotKeyFor('v1')).not.toBe(honeypotKeyFor('v2'));
  });

  it('looks like a plausible field name', () => {
    expect(honeypotKeyFor('v1')).toMatch(/^[a-z_]+_[0-9a-f]{4}$/);
  });
});

describe('attribution sanitisation', () => {
  describe('toPath', () => {
    it('⚠️ strips the query string, which routinely carries PII', () => {
      // A booking confirmation link, an email tracking parameter, a reset
      // token someone pasted. A full landing URL on an acquisition would be
      // PII in a column nobody classifies as PII.
      expect(toPath('/booking?email=sarah@example.test&token=abc123')).toBe('/booking');
    });

    it('reduces an absolute URL to its path', () => {
      expect(toPath('https://abcplumbing.test/emergency-plumber?utm_source=google')).toBe(
        '/emergency-plumber',
      );
    });

    it('returns undefined for an unparseable value rather than storing it', () => {
      expect(toPath('')).toBeUndefined();
      expect(toPath(undefined)).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // ⚠️ The shape check — see ADR-0044
    // -----------------------------------------------------------------------

    describe('⚠️ refuses anything that is not shaped like a landing path', () => {
      // `new URL(x, base)` RESOLVES almost any string against the base rather
      // than throwing, so relying on the throw alone stored these. Measured in
      // dev log 0024 and re-measured in 0025; each was written to the
      // `landing_path` column of a real acquisition.
      it.each([
        ['a bare scheme-ish string', '::::', '/::::'],
        ['a javascript: URL', 'javascript:alert(1)', 'alert(1)'],
        ['a mailto: URL', 'mailto:a@b.test', 'a@b.test'],
        ['a tel: URL', 'tel:+61400000000', '+61400000000'],
        ['a data: URL', 'data:text/html,<b>x</b>', 'text/html,<b>x</b>'],
        ['prose', 'not a url at all', '/not%20a%20url%20at%20all'],
        ['a traversal attempt', '../../etc/passwd', '/etc/passwd'],
      ])('refuses %s, which used to be stored as %s', (_label, input) => {
        expect(toPath(input)).toBeUndefined();
      });
    });

    describe('the shapes a real browser sends are untouched', () => {
      // The tracker sends `window.location.pathname`, which always starts with
      // `/`. Nothing legitimate is caught by the shape check.
      it.each([
        ['/', '/'],
        ['/about', '/about'],
        ['/emergency-plumber-melbourne', '/emergency-plumber-melbourne'],
        ['/blog/2026/03/fixing-a-tap', '/blog/2026/03/fixing-a-tap'],
        ['/booking?email=sarah@example.test', '/booking'],
        ['/caf%C3%A9', '/caf%C3%A9'],
        ['https://abcplumbing.test/pricing', '/pricing'],
        ['http://abcplumbing.test/pricing', '/pricing'],
        ['HTTPS://ABCPLUMBING.TEST/Pricing', '/Pricing'],
      ])('%s stays %s', (input, expected) => {
        expect(toPath(input)).toBe(expected);
      });
    });

    it('⚠️ PROPERTY: anything it returns is a path — it starts with "/"', () => {
      // The invariant that makes the column mean what it says. Before the shape
      // check, 8 of 14 hostile inputs produced a value that was NOT a path:
      // `alert(1)`, `a@b.test`, `+61400000000`, `blank`, `msgbox(1)`,
      // `void(0)`, `text/html,<b>x</b>`, `\\Windows\\system32`.
      const corpus = [
        '/',
        '/about',
        '/a/b/c',
        'https://e.test/x',
        'http://e.test/',
        '//e.test/y',
        '::::',
        'javascript:alert(1)',
        'mailto:a@b.test',
        'tel:+61400000000',
        'data:text/html,<b>x</b>',
        'not a url at all',
        '../../etc/passwd',
        'ftp://e.test/x',
        'file:///etc/passwd',
        'about:blank',
        'chrome://settings',
        'vbscript:msgbox(1)',
        'C:\\Windows\\system32',
        '',
        '   ',
        'e.test/x',
        '?q=1',
        '#frag',
        'HTTPS://E.TEST/Z',
      ];

      for (const input of corpus) {
        const result = toPath(input);
        if (result !== undefined) {
          expect(result.startsWith('/'), `${JSON.stringify(input)} -> ${result}`).toBe(true);
        }
      }
    });

    it('⚠️ PROPERTY: agrees with splitLandingUrl on every input', () => {
      // The defect was two answers to one question, and the live one was the
      // permissive one. They now share the step, so this asserts they cannot
      // drift apart again.
      const inputs = [
        'https://e.test/pricing?utm_source=g',
        '/pricing?utm_source=g',
        '::::',
        'javascript:alert(1)',
        'mailto:a@b.test',
        'not a url at all',
        '../../etc/passwd',
        '//evil.test/x',
        'https://e.test/',
        '',
        '   ',
        'data:text/html,<b>x</b>',
        'tel:+61400000000',
        '/a/../b',
        'ftp://e.test/x',
      ];

      for (const input of inputs) {
        const live = toPath(input);
        const split = splitLandingUrl(input);
        expect(live === undefined, `accept/reject disagreement on ${JSON.stringify(input)}`).toBe(
          split === null,
        );
        if (split !== null) expect(live, input).toBe(split.landingPath);
      }
    });
  });

  describe('toOrigin', () => {
    it('⚠️ discards the search query from a search referrer', () => {
      // Present in rare legacy cases. Capturing it opportunistically would
      // make the keyword report a biased 2% sample presented as data.
      const result = toOrigin('https://www.google.com/search?q=emergency+plumber+melbourne');

      expect(result).toBe('https://www.google.com');
      expect(result).not.toContain('plumber');
    });

    it('returns undefined for the literal "null" a sandboxed frame sends', () => {
      expect(toOrigin('null')).toBeUndefined();
    });
  });

  describe('sanitiseContext', () => {
    it('bounds a hostile campaign value', () => {
      const result = sanitiseContext({ utmCampaign: 'x'.repeat(10_000) });
      expect((result.utmCampaign ?? '').length).toBeLessThanOrEqual(255);
    });

    it('strips control characters that would allow log injection', () => {
      const result = sanitiseContext({ utmSource: 'goo\ngle\r\n[security] fake entry' });
      expect(result.utmSource).not.toMatch(/[\n\r]/);
    });

    it('drops an unknown field rather than passing it through', () => {
      // Built key-by-key rather than by spreading, so a field added to the
      // schema is not silently carried through unsanitised.
      const result = sanitiseContext({
        landingPath: '/x',
        somethingElse: 'passed through?',
      } as never);

      expect(result).not.toHaveProperty('somethingElse');
    });

    it('bounds and cleans the session id', () => {
      const result = sanitiseContext({ sessionId: '../../etc/passwd' });
      expect(result.sessionId).toBe('etcpasswd');
    });

    it('clamps a hostile elapsed time', () => {
      expect(sanitiseContext({ elapsedMs: -5 }).elapsedMs).toBe(0);
      expect(sanitiseContext({ elapsedMs: 1e15 }).elapsedMs).toBe(86_400_000);
    });
  });
});

/**
 * ⚠️ THE PROPERTY THAT STOPS THE FOUR DRIFTING APART AGAIN.
 *
 * Four functions in three packages answered "is this an http(s) location?"
 * with the same prepend-and-parse idiom, and dev log 0018 measured three
 * different answers for one input. They share `httpUrlOf` now (ADR-0045), so
 * the agreement below is structural rather than a coincidence review must
 * re-check — but only a test makes reintroducing a local copy fail loudly.
 *
 * Asserted here, not beside any one of them, because this is the only package
 * that depends on all three others. `sites/origin.ts` says the same thing in
 * its header about its own tests.
 */
describe('the four callers agree on what is an http(s) location', () => {
  // Excludes the literal `null` and any value over 255 characters: the two
  // origin-returning callers apply documented rules of their own there, which
  // is a difference in what they are for, not a disagreement about parsing.
  const CORPUS = [
    'https://abcplumbing.test',
    'https://www.abcplumbing.test',
    'http://abcplumbing.test',
    'https://abcplumbing.test/contact?ref=1',
    'https://abcplumbing.test:8443',
    'abcplumbing.test',
    'www.abcplumbing.test',
    '  https://abcplumbing.test  ',
    '\thttps://evil.test',
    '\nhttps://evil.test',
    '\rhttps://evil.test',
    'ht\ttps://evil.test',
    'https:/\\evil.test',
    'https:\\\\evil.test',
    'file:///etc/passwd',
    'mailto:a@b.test',
    'javascript:alert(1)',
    'chrome://settings',
    'ftp://e.test/x',
    'C:\\Windows',
    '//evil.test/x',
    '/contact',
    'abcplumbing.test:8080',
    '::::',
    '',
    '   ',
  ];

  it.each(CORPUS)('%j — all four accept it or all four refuse it', (input) => {
    const accepted = [
      normaliseOrigin(input) !== null,
      toOrigin(input) !== undefined,
      referrerHost(input) !== null,
      normaliseWebsiteHost(input) !== null,
    ];

    expect(new Set(accepted).size, `${JSON.stringify(input)} -> ${accepted.join()}`).toBe(1);
  });

  it.each(CORPUS)('%j — and derive the same host from it', (input) => {
    const origin = normaliseOrigin(input);
    if (origin === null) return;

    // The two origin-returning callers must not disagree at all.
    expect(toOrigin(input)).toBe(origin);

    // The two host-returning callers strip `www.`; the origin ones must not,
    // because `www.x.test` and `x.test` are different origins to a browser.
    const bare = new URL(origin).hostname.replace(/^www\./, '');
    expect(referrerHost(input)).toBe(bare);
    expect(normaliseWebsiteHost(input)).toBe(bare);
  });

  it('⚠️ none of them can be talked into the fabricated host "https"', () => {
    // The measured failure: a value a browser resolves to `evil.test` failed
    // the prefix test, had `https://` prepended, and parsed with the authority
    // `https`. Dev log 0018 recorded three different answers here; 0026 found
    // a fifth copy and a fourth answer.
    for (const input of ['\thttps://evil.test', 'ht\ttps://evil.test', 'https:/\\evil.test']) {
      expect(normaliseOrigin(input), input).toBe('https://evil.test');
      expect(toOrigin(input), input).toBe('https://evil.test');
      expect(referrerHost(input), input).toBe('evil.test');
      expect(normaliseWebsiteHost(input), input).toBe('evil.test');
    }
  });

  it('⚠️ none of them manufacture an authority out of a path or a scheme name', () => {
    // `/contact` became the origin `https://contact`; `file:///etc/passwd`
    // became `https://file`; `mailto:a@b.test` borrowed the real domain
    // `b.test` out of the opaque part.
    for (const input of ['/contact', 'file:///etc/passwd', 'mailto:a@b.test', 'C:\\Windows']) {
      expect(normaliseOrigin(input), input).toBeNull();
      expect(toOrigin(input), input).toBeUndefined();
      expect(referrerHost(input), input).toBeNull();
      expect(normaliseWebsiteHost(input), input).toBeNull();
    }
  });
});
