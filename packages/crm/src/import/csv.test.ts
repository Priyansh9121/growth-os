/**
 * CSV parser tests.
 *
 * This is the first place an untrusted customer file enters the system, so the
 * cases below are chosen for what actually arrives from Excel, Google Sheets
 * and fifteen-year-old bespoke exports — not for what a clean specification
 * would produce.
 */

import { describe, expect, it } from 'vitest';
import { IMPORT_MAX_ROWS, neutraliseCsvFormula } from '@growth-os/contracts';
import { parseCsv } from './csv';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('parseCsv', () => {
  it('parses a plain file', () => {
    const result = parseCsv(encode('First,Email\nSarah,sarah@example.test\n'));

    expect(result.headers).toEqual(['First', 'Email']);
    expect(result.rows).toEqual([{ First: 'Sarah', Email: 'sarah@example.test' }]);
    expect(result.truncatedRows).toBe(0);
  });

  it('keeps commas inside quoted fields', () => {
    // The single most common real-world case: an address.
    const result = parseCsv(encode('Name,Address\nSarah,"12 Smith St, Fitzroy"\n'));

    expect(result.rows[0]?.['Address']).toBe('12 Smith St, Fitzroy');
  });

  it('treats "" inside a quoted field as one quote', () => {
    const result = parseCsv(encode('Name,Note\nSarah,"She said ""call me"""\n'));

    expect(result.rows[0]?.['Note']).toBe('She said "call me"');
  });

  it('keeps newlines inside quoted fields', () => {
    const result = parseCsv(encode('Name,Address\nSarah,"12 Smith St\nFitzroy"\n'));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.['Address']).toBe('12 Smith St\nFitzroy');
  });

  it.each([
    ['CRLF (Windows)', 'A,B\r\n1,2\r\n'],
    ['LF (Unix)', 'A,B\n1,2\n'],
    ['CR (classic Mac)', 'A,B\r1,2\r'],
  ])('handles %s line endings', (_label, text) => {
    const result = parseCsv(encode(text));

    expect(result.rows).toEqual([{ A: '1', B: '2' }]);
  });

  it('strips the byte-order mark Excel writes', () => {
    // Left in place, the BOM becomes part of the first header, and the operator
    // is told their Email column is missing while looking straight at it.
    const result = parseCsv(encode('﻿Email,Name\nsarah@example.test,Sarah\n'));

    expect(result.headers[0]).toBe('Email');
  });

  it('pads rows that omit trailing empty cells', () => {
    // Spreadsheets do this routinely. Refusing would block an importable file.
    const result = parseCsv(encode('A,B,C\n1\n'));

    expect(result.rows[0]).toEqual({ A: '1', B: '', C: '' });
  });

  it('drops the empty row a trailing newline produces', () => {
    const result = parseCsv(encode('A\n1\n'));

    expect(result.rows).toHaveLength(1);
  });

  it('rejects a blank column heading', () => {
    // A blank heading cannot be mapped to anything, and auto-numbering it would
    // produce a column the operator never sees in the mapping step.
    expect(() => parseCsv(encode('Name,,Email\nSarah,x,y\n'))).toThrow(/heading/i);
  });

  it('rejects duplicate column headings', () => {
    // Rows are keyed by header, so two identically-named columns means one
    // silently wins.
    expect(() => parseCsv(encode('Email,Email\na,b\n'))).toThrow(/both called/i);
  });

  it('rejects an unclosed quotation mark rather than importing a mangled row', () => {
    expect(() => parseCsv(encode('Name\n"Sarah\n'))).toThrow(/unclosed/i);
  });

  it('rejects invalid UTF-8 instead of substituting replacement characters', () => {
    // A silently mangled name is worse than a rejected file: the mangling is
    // only discovered later, in someone's CRM.
    expect(() => parseCsv(new Uint8Array([0x41, 0x0a, 0xff, 0xfe, 0x0a]))).toThrow(/UTF-8/);
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv(encode(''))).toThrow(/empty/i);
  });

  it('reports rows beyond the cap rather than silently dropping them', () => {
    const lines = ['Name', ...Array.from({ length: IMPORT_MAX_ROWS + 5 }, (_, i) => `n${i}`)];
    const result = parseCsv(encode(lines.join('\n')));

    expect(result.rows).toHaveLength(IMPORT_MAX_ROWS);
    // The count is what lets the UI say "5 rows were not imported" instead of
    // reporting a clean success.
    expect(result.truncatedRows).toBe(5);
  });

  it('rejects a file larger than the byte cap before decoding it', () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    expect(() => parseCsv(oversized)).toThrow(/MB/);
  });

  it('trims surrounding whitespace from values', () => {
    const result = parseCsv(encode('Email\n  sarah@example.test  \n'));

    expect(result.rows[0]?.['Email']).toBe('sarah@example.test');
  });
});

describe('neutraliseCsvFormula', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'prefixes %j so a spreadsheet treats it as text',
    (dangerous) => {
      expect(neutraliseCsvFormula(dangerous)).toBe(`'${dangerous}`);
    },
  );

  it('leaves ordinary values alone', () => {
    // Over-prefixing would put a stray apostrophe in front of every name.
    expect(neutraliseCsvFormula("O'Brien")).toBe("O'Brien");
    expect(neutraliseCsvFormula('sarah@example.test')).toBe('sarah@example.test');
    expect(neutraliseCsvFormula('12 Smith St')).toBe('12 Smith St');
  });

  it('neutralises the canonical command-execution payload', () => {
    // `=cmd|'/c calc'!A1` is a spreadsheet exploit, not a name.
    expect(neutraliseCsvFormula("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });
});
