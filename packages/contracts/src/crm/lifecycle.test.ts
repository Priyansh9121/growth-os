/**
 * Custom field key bounds.
 *
 * ⚠️ NARROW ON PURPOSE. `lifecycle.ts` carries a great deal more than this, and
 * none of it is covered here — this file exists for `customFieldKey`, which
 * paired `.max()` with an unbounded quantifier, the shape ADR-0046 fixed on
 * `fieldTarget` and dev logs 0027–0030 carried as a remaining item.
 *
 * Asserted through `createCustomFieldSchema` rather than the inner schema,
 * because that is the gate a caller actually passes through.
 *
 * @see docs/decisions/ADR-0046-field-target-bound.md
 */

import { describe, expect, it } from 'vitest';
import { createCustomFieldSchema } from './lifecycle';
import { CUSTOM_FIELD_KEY_MAX_LENGTH } from './enums';

const field = (key: string) => ({ key, label: 'Property type', type: 'text' as const });

describe('customFieldKey — bounded quantifier, not merely a bounded string', () => {
  it('accepts a key of exactly the permitted length and refuses one over', () => {
    // The bound is derived from CUSTOM_FIELD_KEY_MAX_LENGTH in both the
    // `.max()` and the pattern, so this pins them to each other rather than to
    // a literal that could drift from either.
    expect(
      createCustomFieldSchema.safeParse(field('a'.repeat(CUSTOM_FIELD_KEY_MAX_LENGTH))).success,
    ).toBe(true);
    expect(
      createCustomFieldSchema.safeParse(field('a'.repeat(CUSTOM_FIELD_KEY_MAX_LENGTH + 1))).success,
    ).toBe(false);
  });

  it.each([
    ['a', 'the shortest legal key'],
    ['a1', 'letters and digits'],
    ['property_type', 'an ordinary key'],
  ])('still accepts %j (%s)', (key) => {
    expect(createCustomFieldSchema.safeParse(field(key)).success).toBe(true);
  });

  it('still refuses a malformed key of legal length — the shape check survived', () => {
    // The bound must not have replaced the pattern.
    for (const bad of ['1abc', 'Abc', 'a-b', 'a b', '_a', '']) {
      expect(createCustomFieldSchema.safeParse(field(bad)).success, bad).toBe(false);
    }
  });

  it('runs the pattern even though .max() has already failed', () => {
    // Why a bounded quantifier is needed at all: zod v4 collects every issue,
    // so the length check does not short-circuit the pattern. Both codes
    // appearing is the evidence the pattern still ran at full length.
    const result = createCustomFieldSchema.safeParse(field('k'.repeat(200_000)));

    expect(result.success).toBe(false);
    if (result.success) return;

    const codes = result.error.issues.map((issue) => issue.code);
    expect(codes).toContain('too_big');
    expect(codes).toContain('invalid_format');
  });

  it('costs the same on a 4 MB key as on a 4 KB one', () => {
    // The strong property (§6). Measured while writing this (dev log 0031):
    // 231.7x with `*`, 1.1x with the bounded quantifier, for the same 1000x
    // increase in input. The threshold sits an order of magnitude clear of
    // both, so it fails if someone restores `*` and passes under CI noise.
    const measure = (size: number, iterations: number): number => {
      const value = field('k'.repeat(size));
      const started = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) createCustomFieldSchema.safeParse(value);
      return Number(process.hrtime.bigint() - started) / iterations;
    };

    measure(4_000, 200); // warm the JIT

    const small = measure(4_000, 500);
    const large = measure(4_000_000, 50);

    expect(large / small).toBeLessThan(20);
  });
});
