/**
 * LIKE pattern construction — the string half.
 *
 * ⚠️ THESE ASSERT THE PATTERN, WHICH IS THE WEAK PROPERTY. What actually
 * matters is which rows PostgreSQL matches, and that is asserted against a
 * running database in `lifecycle.integration.test.ts` — §6, and 0018's own
 * method of measuring LIKE semantics rather than reasoning about them. These
 * exist because they run without a database and fail faster.
 */

import { describe, expect, it } from 'vitest';
import { containsPattern, escapeLike } from './like';

describe('escapeLike', () => {
  it('⚠️ escapes the backslash, which is the character the old copies missed', () => {
    // The whole defect. Escaping `%` and `_` without escaping `\` mis-assigns
    // every escape after the first backslash the user typed.
    expect(escapeLike('Sara\\Jones')).toBe('Sara\\\\Jones');
  });

  it.each([
    ['%', '\\%', 'the wildcard'],
    ['_', '\\_', 'the single-character wildcard'],
    ['\\', '\\\\', 'the escape character itself'],
  ])('escapes %j as %j (%s)', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });

  it('escapes each source character exactly once — replace does not rescan', () => {
    // The assumption that would make a two-pass implementation double-escape,
    // asserted rather than trusted: escaping `\` first must not then escape the
    // backslash it just produced.
    expect(escapeLike('\\')).toBe('\\\\');
    expect(escapeLike('\\\\')).toBe('\\\\\\\\');
    expect(escapeLike('a\\%b')).toBe('a\\\\\\%b');
  });

  it('leaves text with no metacharacters untouched', () => {
    for (const plain of ['Nadia', 'nadia@example.test', '0412 987 654', 'Sara Jones', '']) {
      expect(escapeLike(plain), plain).toBe(plain);
    }
  });

  it('escapes every metacharacter in a mixed term', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('containsPattern', () => {
  it('wraps in wildcards so a caller cannot escape correctly and forget the %', () => {
    expect(containsPattern('Nadia')).toBe('%Nadia%');
  });

  it('⚠️ keeps the trailing wildcard a wildcard when the term ends in a backslash', () => {
    // Dev log 0018's case. The old form produced `%a\%`, in which the closing
    // wildcard is consumed as an escaped literal `%` — so the pattern stopped
    // being a substring search at all.
    expect(containsPattern('a\\')).toBe('%a\\\\%');
    expect(containsPattern('a\\')).not.toBe('%a\\%');
  });

  it('produces a pattern whose wildcards are only the ones it added', () => {
    // Property, not an example: after escaping, the only unescaped `%` or `_`
    // in the pattern must be the two this function put there.
    for (const term of ['Sara\\Jones', 'a\\', 'Sara%', 'a_b', 'C:\\Users\\sam', '%%%', '___']) {
      const pattern = containsPattern(term);
      const body = pattern.slice(1, -1);

      // Walk the escaped body: every `%` and `_` must be preceded by an escape.
      let unescapedWildcards = 0;
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\\') {
          i++; // skip the escaped character
          continue;
        }
        if (ch === '%' || ch === '_') unescapedWildcards++;
      }

      expect(unescapedWildcards, `${term} -> ${pattern}`).toBe(0);
      expect(pattern.startsWith('%'), term).toBe(true);
      expect(pattern.endsWith('%'), term).toBe(true);
    }
  });
});
