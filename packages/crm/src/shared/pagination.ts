/**
 * Keyset (cursor) pagination.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Encodes and decodes the opaque cursor used by every CRM list endpoint.
 *
 * WHY KEYSET RATHER THAN OFFSET
 * `OFFSET 50000` makes PostgreSQL walk and discard 50,000 rows, so cost grows
 * linearly with depth. Worse, offset pagination **skips and duplicates rows**
 * when data changes between page loads — which happens constantly in a CRM
 * that someone else is editing. Keyset is O(log n) via the index and stable
 * under concurrent writes.
 *
 * WHY OPAQUE
 * A client that can read the cursor will come to depend on its shape, and we
 * lose the freedom to change the sort. It is base64url of a small JSON object,
 * and it is CLIENT-SUPPLIED INPUT — so it is validated on the way back in and
 * rejected if malformed, never trusted.
 *
 * @see docs/decisions/ADR-0016-list-pagination-and-filtering.md
 */

import { ValidationError } from '@growth-os/contracts';

export interface Cursor {
  /** The sort key's value at the last row of the previous page. */
  readonly value: string;
  /** Row id, breaking ties when the sort key is not unique. */
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode a client-supplied cursor.
 *
 * Returns `null` for absent input. Throws for malformed input rather than
 * silently restarting from page one — silently ignoring a bad cursor would
 * make pagination bugs invisible while quietly re-serving the first page.
 *
 * @throws ValidationError
 */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined || raw.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Cursor).value !== 'string' ||
      typeof (parsed as Cursor).id !== 'string'
    ) {
      throw new Error('shape');
    }
    return parsed as Cursor;
  } catch {
    throw new ValidationError('Invalid pagination cursor.');
  }
}

/**
 * Fetch one extra row to determine whether a further page exists, without a
 * second COUNT query — which would double the work on every list request.
 */
export function sliceToPage<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  sortValue: (row: T) => string,
): { items: readonly T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last ? encodeCursor({ value: sortValue(last), id: last.id }) : null,
  };
}
