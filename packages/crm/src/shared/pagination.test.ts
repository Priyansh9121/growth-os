/**
 * Cursor pagination.
 *
 * The cursor is CLIENT-SUPPLIED INPUT, so the decoder is a trust boundary and
 * is tested as one.
 *
 * @see docs/decisions/ADR-0016-list-pagination-and-filtering.md
 */

import { describe, expect, it } from 'vitest';
import { ValidationError } from '@growth-os/contracts';
import { decodeCursor, encodeCursor, sliceToPage } from './pagination';

describe('cursor round trip', () => {
  it('encodes and decodes losslessly', () => {
    const cursor = { value: '2026-08-15T00:00:00.000Z', id: 'abc-123' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('produces a URL-safe string', () => {
    const encoded = encodeCursor({ value: '2026-08-15T00:00:00.000Z', id: 'a/b+c' });
    // base64url: no +, / or = to be mangled in a query string.
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('decodeCursor rejects hostile input', () => {
  it('returns null for absent input', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('THROWS for malformed input rather than silently restarting', () => {
    // Silently ignoring a bad cursor would re-serve page one and make
    // pagination bugs invisible.
    expect(() => decodeCursor('not-base64!!')).toThrow(ValidationError);
    expect(() => decodeCursor(Buffer.from('{"nope":1}').toString('base64url'))).toThrow(
      ValidationError,
    );
  });

  it('rejects a structurally valid but wrongly-typed cursor', () => {
    const hostile = Buffer.from(JSON.stringify({ value: 42, id: [] })).toString('base64url');
    expect(() => decodeCursor(hostile)).toThrow(ValidationError);
  });
});

describe('sliceToPage', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `id-${index}`,
    createdAt: `2026-08-${10 + index}`,
  }));

  it('returns a next cursor when an extra row was fetched', () => {
    // The N+1 fetch reveals a further page without a second COUNT query.
    const page = sliceToPage(rows, 5, (row) => row.createdAt);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toEqual({ value: '2026-08-14', id: 'id-4' });
  });

  it('returns no cursor on the final page', () => {
    const page = sliceToPage(rows.slice(0, 3), 5, (row) => row.createdAt);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = sliceToPage([], 25, () => '');
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});
