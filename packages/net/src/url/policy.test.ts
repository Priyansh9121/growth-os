/**
 * URL admission — the syntactic half of the SSRF matrix.
 *
 * Paired with `address/classify.test.ts`. Together they are the specification
 * for what Growth OS will and will not open a socket to; separately, neither
 * proves anything, because a URL that passes here may still resolve to a
 * private address and an address that passes there may have arrived over
 * `gopher:`.
 */

import { describe, expect, it } from 'vitest';
import { admitUrl, bareHost, effectivePort, isSensitiveParameter } from './policy';

describe('admitUrl', () => {
  describe('schemes', () => {
    it.each(['http://example.test/', 'https://example.test/', 'HTTPS://EXAMPLE.TEST/'])(
      'admits %s',
      (input) => {
        expect(admitUrl(input).ok).toBe(true);
      },
    );

    // An ALLOW-list, so this is not an exhaustive enumeration of evil — a
    // scheme absent from both lists is still refused.
    it.each([
      ['file:///etc/passwd', 'file'],
      ['ftp://example.test/x', 'ftp'],
      ['gopher://example.test:70/_x', 'gopher'],
      ['data:text/html,<script>alert(1)</script>', 'data'],
      ['javascript:alert(1)', 'javascript'],
      ['ws://example.test/', 'ws'],
      ['wss://example.test/', 'wss'],
      ['blob:https://example.test/uuid', 'blob'],
      ['jar:http://example.test!/x', 'jar'],
      ['dict://example.test:2628/x', 'dict'],
      ['ldap://example.test/x', 'ldap'],
      ['sftp://example.test/x', 'sftp'],
      ['netdoc:///etc/passwd', 'netdoc'],
    ])('refuses %s', (input) => {
      const verdict = admitUrl(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe('scheme_not_allowed');
    });

    it('refuses a relative URL rather than resolving it against something', () => {
      const verdict = admitUrl('/robots.txt');
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe('unparseable');
    });
  });

  describe('credentials', () => {
    // ⚠️ `https://evil.test@10.0.0.1/` reads as `evil.test` to a human and
    // resolves to `10.0.0.1`. Refused rather than stripped: stripping would
    // fetch a different resource than the URL named.
    it.each([
      'http://user:password@example.test/',
      'https://user@example.test/',
      'https://:password@example.test/',
      'https://evil.test@93.184.216.34/',
    ])('refuses %s', (input) => {
      const verdict = admitUrl(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe('credentials_present');
    });

    it('never puts the password in the rejection detail', () => {
      const verdict = admitUrl('http://user:hunter2@example.test/');
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.detail).not.toContain('hunter2');
    });
  });

  describe('ports', () => {
    it.each(['http://example.test/', 'https://example.test/', 'http://example.test:80/'])(
      'admits the default port in %s',
      (input) => {
        expect(admitUrl(input).ok).toBe(true);
      },
    );

    it('admits an explicit 443 on https', () => {
      expect(admitUrl('https://example.test:443/').ok).toBe(true);
    });

    // The point is not that these particular ports are bad. It is that a host
    // may be entirely public — passing the address classifier — while the PORT
    // is what reaches something that is not a website.
    it.each([
      ['http://example.test:22/', 'ssh'],
      ['http://example.test:25/', 'smtp'],
      ['http://example.test:3306/', 'mysql'],
      ['http://example.test:5432/', 'postgres'],
      ['http://example.test:6379/', 'redis'],
      ['http://example.test:9200/', 'elasticsearch'],
      ['http://example.test:11211/', 'memcached'],
      ['http://example.test:8080/', 'a plausible web port, still refused'],
      ['https://example.test:8443/', 'a plausible TLS port, still refused'],
    ])('refuses %s (%s)', (input) => {
      const verdict = admitUrl(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe('port_not_allowed');
    });

    it('refuses an https URL on port 80 and an http URL on 443 only if the port is not 80/443', () => {
      // Both are odd but not dangerous; the allow-list is by port number, not
      // by scheme/port agreement, and this pins that deliberate choice.
      expect(admitUrl('https://example.test:80/').ok).toBe(true);
      expect(admitUrl('http://example.test:443/').ok).toBe(true);
    });
  });

  describe('sensitive query parameters', () => {
    // ⚠️ NOT FETCHED, not merely redacted. Fetching a single-use link consumes
    // it; fetching a session URL acts as that person; storing a URL with an
    // address in it puts personal data outside erasure's model.
    it.each([
      'https://example.test/x?token=abc',
      'https://example.test/x?access_token=abc',
      'https://example.test/x?sessionid=abc',
      'https://example.test/x?PHPSESSID=abc',
      'https://example.test/x?auth=abc',
      'https://example.test/x?signature=abc',
      'https://example.test/x?X-Amz-Sig=abc',
      'https://example.test/reset?reset=abc',
      'https://example.test/x?unsubscribe=abc',
      'https://example.test/x?email=someone@example.test',
      'https://example.test/x?phone=0400000000',
      'https://example.test/x?page=2&token=abc',
    ])('refuses %s', (input) => {
      const verdict = admitUrl(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe('sensitive_query');
    });

    it('names the parameter but never its value', () => {
      const verdict = admitUrl('https://example.test/x?token=SUPERSECRETVALUE');
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.detail).toContain('token');
        expect(verdict.detail).not.toContain('SUPERSECRETVALUE');
      }
    });

    // The other half of the decision, and the more important half: a control
    // that skips real pages is a crawler that lies about coverage.
    it.each([
      'https://example.test/products?code=SPRING20',
      'https://example.test/branches?state=VIC',
      'https://example.test/search?key=colour&value=red',
      'https://example.test/p?id=42',
      'https://example.test/blog?tokenizer=greedy',
      'https://example.test/portfolio?design=modern',
      'https://example.test/x?utm_source=google&utm_campaign=spring',
    ])('admits %s', (input) => {
      expect(admitUrl(input).ok).toBe(true);
    });

    it('matches whole words in a compound name, not substrings', () => {
      expect(isSensitiveParameter('access_token')).toBe(true);
      expect(isSensitiveParameter('X-Amz-Signature')).toBe(true);
      expect(isSensitiveParameter('user.email')).toBe(true);
      expect(isSensitiveParameter('tokenizer')).toBe(false);
      expect(isSensitiveParameter('broken')).toBe(false);
      expect(isSensitiveParameter('design')).toBe(false);
    });
  });

  describe('size limits', () => {
    it('refuses an absurdly long URL', () => {
      const verdict = admitUrl(`https://example.test/${'a'.repeat(4000)}`);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe('url_too_long');
    });

    it('refuses a host longer than DNS permits', () => {
      const host = `${'a'.repeat(60)}.`.repeat(5);
      const verdict = admitUrl(`https://${host}example.test/`);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe('host_too_long');
    });
  });

  describe('hosts that are addresses', () => {
    // ⚠️ ADMITTED HERE, ON PURPOSE. This layer is syntactic. Refusing literals
    // at parse time would look like a control and would be trivially bypassed
    // by any hostname that resolves to the same place — so the real check is
    // the classifier, at connect time, for every host equally.
    it.each(['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/'])(
      'admits %s syntactically, leaving the address check to the classifier',
      (input) => {
        expect(admitUrl(input).ok).toBe(true);
      },
    );
  });
});

describe('bareHost', () => {
  it('strips the brackets an IPv6 literal carries', () => {
    // `URL.hostname` is the seven characters `[::1]`, which `isIP` rejects —
    // so a classifier fed the raw value would call loopback "not an address".
    expect(bareHost(new URL('http://[::1]/'))).toBe('::1');
    expect(bareHost(new URL('http://[::ffff:127.0.0.1]/'))).toBe('::ffff:7f00:1');
  });

  it('strips a root-zone trailing dot', () => {
    // `example.com.` and `example.com` are the same site and different strings.
    expect(bareHost(new URL('http://example.com./'))).toBe('example.com');
  });

  it('leaves an ordinary host alone, lowercased by the parser', () => {
    expect(bareHost(new URL('http://EXAMPLE.com/'))).toBe('example.com');
  });
});

describe('effectivePort', () => {
  it('makes the scheme default explicit', () => {
    expect(effectivePort(new URL('http://example.test/'))).toBe(80);
    expect(effectivePort(new URL('https://example.test/'))).toBe(443);
    expect(effectivePort(new URL('https://example.test:8443/'))).toBe(8443);
  });
});
