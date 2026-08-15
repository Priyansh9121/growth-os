/**
 * Identity normalisation.
 *
 * These are the matching keys deduplication depends on. A bug here either
 * merges two different people (destructive, irreversible) or fails to match
 * one person with themselves (fragmented timeline). Both are worth testing
 * exhaustively.
 *
 * @see docs/decisions/ADR-0015-contact-identity-and-deduplication.md
 */

import { describe, expect, it } from 'vitest';
import { displayName, normaliseEmail, normalisePhone, normaliseWebsiteHost } from './normalise';

describe('normaliseEmail', () => {
  it('trims and lowercases', () => {
    expect(normaliseEmail('  Sarah.Mitchell@Example.TEST  ')).toBe('sarah.mitchell@example.test');
  });

  it('does NOT strip dots', () => {
    // Gmail treats these as one mailbox; almost nobody else does. Applying
    // Gmail's rule universally would silently merge different people at other
    // providers — and a wrong merge is not reversible.
    expect(normaliseEmail('first.last@company.test')).toBe('first.last@company.test');
    expect(normaliseEmail('firstlast@company.test')).toBe('firstlast@company.test');
    expect(normaliseEmail('first.last@company.test')).not.toBe(
      normaliseEmail('firstlast@company.test'),
    );
  });

  it('does NOT strip +aliases', () => {
    // `sarah+plumbing@` may be a deliberately distinct contact route the
    // customer uses to track where enquiries came from.
    expect(normaliseEmail('sarah+plumbing@example.test')).toBe('sarah+plumbing@example.test');
    expect(normaliseEmail('sarah+plumbing@example.test')).not.toBe(
      normaliseEmail('sarah@example.test'),
    );
  });

  it('returns null for absent or empty input', () => {
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(undefined)).toBeNull();
    expect(normaliseEmail('   ')).toBeNull();
  });
});

describe('normalisePhone', () => {
  it('treats the same Australian number written three ways as identical', () => {
    // The core requirement: a form, a call and a voice agent will each capture
    // the same number differently, and all three must reach one contact.
    const spaced = normalisePhone('0412 345 678', 'AU');
    const international = normalisePhone('+61 412 345 678', 'AU');
    const compact = normalisePhone('0412345678', 'AU');

    expect(spaced).toBe('+61412345678');
    expect(international).toBe(spaced);
    expect(compact).toBe(spaced);
  });

  it('respects the workspace region rather than assuming Australia', () => {
    // `0412 345 678` is a valid mobile in AU. The same digits parse
    // differently elsewhere — which is exactly why the region is per-workspace
    // rather than a global constant.
    const auResult = normalisePhone('0412 345 678', 'AU');
    const gbResult = normalisePhone('020 7946 0958', 'GB');

    expect(auResult).toBe('+61412345678');
    expect(gbResult).toBe('+442079460958');
  });

  it('handles a lowercase region code', () => {
    expect(normalisePhone('0412 345 678', 'au')).toBe('+61412345678');
  });

  it('returns null rather than a mangled guess for unparseable input', () => {
    // A half-normalised number looks valid but silently fails to match the
    // same person's real number — worse than no key at all.
    expect(normalisePhone('not a phone', 'AU')).toBeNull();
    expect(normalisePhone('123', 'AU')).toBeNull();
    expect(normalisePhone('', 'AU')).toBeNull();
    expect(normalisePhone(null, 'AU')).toBeNull();
  });

  it('returns null for an invalid region rather than throwing', () => {
    // A bad workspace setting must not fail an acquisition.
    expect(normalisePhone('0412 345 678', 'ZZ')).toBeNull();
  });

  it('rejects possible-but-invalid numbers', () => {
    // `isValid` not `isPossible`: possible-but-invalid numbers produce false
    // matches between different people.
    expect(normalisePhone('+61 400 000 000 000', 'AU')).toBeNull();
  });
});

describe('normaliseWebsiteHost', () => {
  it('reduces a URL to a bare lowercase host', () => {
    expect(normaliseWebsiteHost('https://www.ABCPlumbing.test/contact?ref=1')).toBe(
      'abcplumbing.test',
    );
  });

  it('accepts a bare hostname without a scheme', () => {
    expect(normaliseWebsiteHost('abcplumbing.test')).toBe('abcplumbing.test');
  });

  it('strips a www prefix so both forms agree', () => {
    expect(normaliseWebsiteHost('www.abcplumbing.test')).toBe(
      normaliseWebsiteHost('abcplumbing.test'),
    );
  });

  it('returns null for unusable input', () => {
    expect(normaliseWebsiteHost('')).toBeNull();
    expect(normaliseWebsiteHost(null)).toBeNull();
  });
});

describe('displayName', () => {
  it('joins first and last name', () => {
    expect(displayName('Sarah', 'Mitchell')).toBe('Sarah Mitchell');
  });

  it('handles a missing surname — many contacts arrive with one name', () => {
    expect(displayName('Sarah', null)).toBe('Sarah');
  });
});
