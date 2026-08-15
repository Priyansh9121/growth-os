/**
 * CSV parsing for contact import.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Turns an uploaded file into rows, or explains precisely why it cannot.
 *
 * WHY FIRST-PARTY RATHER THAN A LIBRARY
 * This is the first place untrusted customer files enter the system, so the
 * parse surface is a security surface. A hand-written parser here is ~120 lines
 * of well-understood state machine that we can bound, test exhaustively and
 * read in a diff — against a transitive dependency tree on the one code path
 * where a supply-chain compromise would read every customer's contact list.
 *
 * The trade is real and stated plainly: a library would handle more exotic
 * dialects (semicolon separators, alternate quoting) than this does. Those are
 * a feature request, and adding one is a decision to make deliberately rather
 * than to inherit.
 *
 * WHAT THIS DOES NOT DO
 * It does not touch the filesystem. The file is parsed from the request body
 * in memory, under a size cap, so there is no upload directory to leak, scan,
 * or forget to clean up — and no path for a customer CSV to be committed by
 * accident (ADR-0023 §6).
 *
 * @see docs/decisions/ADR-0023-csv-import.md
 */

import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, ValidationError } from '@growth-os/contracts';

export interface ParsedCsv {
  readonly headers: readonly string[];
  /** One entry per data row, keyed by header. Trailing blank rows are dropped. */
  readonly rows: readonly Record<string, string>[];
  /**
   * Rows present in the file beyond `IMPORT_MAX_ROWS`.
   *
   * Reported rather than silently discarded: an import that quietly stopped at
   * row 10,000 and said "completed" is the worst possible outcome for someone
   * migrating their business (ADR-0023).
   */
  readonly truncatedRows: number;
}

/** Longest single cell accepted. Bounds memory per row and per field. */
const MAX_FIELD_LENGTH = 4000;
/** Widest row accepted. A file with 500 columns is not a contact list. */
const MAX_COLUMNS = 60;

/**
 * Parse a CSV file.
 *
 * @throws ValidationError with a message safe to show an operator. The message
 *   never echoes a cell's contents — a parse error is not a reason to reflect
 *   customer data back into a response body or a log line.
 */
export function parseCsv(input: Uint8Array): ParsedCsv {
  // Checked FIRST. A cap applied after decoding has already spent the memory
  // it was meant to bound, which makes it decoration rather than a limit.
  if (input.byteLength > IMPORT_MAX_BYTES) {
    throw new ValidationError(
      `That file is larger than ${Math.floor(IMPORT_MAX_BYTES / (1024 * 1024))} MB.`,
    );
  }

  const text = decodeUtf8(input);
  const table = tokenise(text);

  const headerRow = table.shift();
  if (!headerRow) throw new ValidationError('That file is empty.');

  const headers = headerRow.map((header) => header.trim());

  if (headers.length > MAX_COLUMNS) {
    throw new ValidationError(`That file has more than ${MAX_COLUMNS} columns.`);
  }
  if (headers.some((header) => header.length === 0)) {
    // A blank header cannot be mapped to anything, and silently numbering it
    // would produce a column the operator never sees in the mapping step.
    throw new ValidationError('Every column needs a heading. One or more headings are blank.');
  }

  const duplicate = firstDuplicate(headers);
  if (duplicate !== null) {
    // Rows are keyed by header, so two columns with the same name means one
    // silently wins. Refusing is the only honest option.
    throw new ValidationError(`Two columns are both called "${duplicate}". Rename one.`);
  }

  const rows: Record<string, string>[] = [];
  let truncatedRows = 0;

  for (const cells of table) {
    // A trailing newline produces a final row of one empty cell. That is a
    // file artefact, not a contact.
    if (cells.length === 1 && cells[0]?.trim() === '') continue;

    if (rows.length >= IMPORT_MAX_ROWS) {
      truncatedRows += 1;
      continue;
    }

    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      // Short rows are padded rather than rejected. Spreadsheets routinely omit
      // trailing empty cells, and refusing the file over it would block a
      // perfectly importable export.
      row[header] = (cells[index] ?? '').trim();
    });
    rows.push(row);
  }

  return { headers, rows, truncatedRows };
}

/**
 * Decode bytes as UTF-8, stripping a byte-order mark.
 *
 * Excel on Windows writes a BOM by default. Left in place, U+FEFF becomes the
 * first character of the first header — so that header no longer matches a
 * mapping for `"Email"`, and the operator is told their email column is
 * missing while looking straight at it.
 *
 * `fatal: true` so undecodable bytes raise rather than being replaced with
 * U+FFFD. A silently mangled name is worse than a rejected file, because the
 * mangling is only discovered later, in someone's CRM.
 */
function decodeUtf8(input: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new ValidationError(
      'That file is not valid UTF-8 text. Re-export it as CSV UTF-8 and try again.',
    );
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * RFC 4180 tokeniser.
 *
 * Handles quoted fields, `""` as an escaped quote inside them, embedded
 * newlines, and CRLF / LF / lone-CR line endings. Written as an explicit state
 * machine rather than a regex because CSV is not a regular language once
 * quoting is involved — a regex-based splitter breaks on the first address
 * containing a comma, which is most of them.
 */
function tokenise(text: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const pushField = (): void => {
    if (field.length > MAX_FIELD_LENGTH) {
      throw new ValidationError(`One of the values is longer than ${MAX_FIELD_LENGTH} characters.`);
    }
    row.push(field);
    field = '';
  };

  const pushRow = (): void => {
    pushField();
    table.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      pushField();
      index += 1;
      continue;
    }

    if (char === '\r') {
      pushRow();
      // CRLF counts as one terminator; a lone CR (classic Mac) as one too.
      index += text[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    if (char === '\n') {
      pushRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // An unterminated quote means the file is malformed — most often a stray `"`
  // inside an unquoted field. Everything after it was swallowed into one cell,
  // so importing would be silently wrong.
  if (quoted) {
    throw new ValidationError(
      'That file has an unclosed quotation mark, so its rows cannot be read reliably.',
    );
  }

  // Anything buffered after the last terminator is the final row.
  if (field.length > 0 || row.length > 0) pushRow();

  return table;
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) return value;
    seen.add(key);
  }
  return null;
}
