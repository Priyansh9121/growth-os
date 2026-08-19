/**
 * Form configuration bounds.
 *
 * Every assertion here goes through `formVersionConfigSchema` rather than
 * through `fieldTarget` directly, because §6 asks what is **stored**: this
 * schema is the gate on `form_versions.fields`, and a bound that holds on the
 * inner schema but not through the outer one would be a bound on nothing.
 *
 * @see docs/development-log/0027-the-field-target-cap.md
 */

import { describe, expect, it } from 'vitest';
import { formVersionConfigSchema } from './schemas';
import { CUSTOM_FIELD_KEY_MAX_LENGTH } from '../crm/enums';

const PREFIX = 'custom:';

/** The longest target that can name a real custom field key. */
const LONGEST_VALID = PREFIX + 'a'.repeat(CUSTOM_FIELD_KEY_MAX_LENGTH);

const config = (target: string) => ({
  fields: [{ key: 'a', type: 'text' as const, label: 'A', target }],
  settings: {},
});

describe('fieldTarget — the value is refused, not stored and not truncated', () => {
  /**
   * Dev log 0018 measured a 200,007-character `custom:aaa…` parsing
   * successfully and reaching stored config. Re-measured at 4242da1 before the
   * fix: it still parsed, and `.data` carried all 200,007 characters through —
   * so this is the exact input, not an approximation of it.
   */
  it('refuses the 200,007-character target dev log 0018 measured', () => {
    const result = formVersionConfigSchema.safeParse(config(PREFIX + 'a'.repeat(200_000)));

    expect(result.success).toBe(false);
  });

  it('⚠️ refuses it rather than truncating it — there is no shortened value stored', () => {
    // The failure mode a `.max()` must not have: accepting the row and
    // silently keeping a prefix. `safeParse` failing means no `data` exists at
    // all, so nothing reaches `form_versions.fields`.
    const result = formVersionConfigSchema.safeParse(config(PREFIX + 'a'.repeat(200_000)));

    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('data');
  });

  it.each([1_000, 200_000, 1_000_000])('refuses a %i-character custom key', (n) => {
    expect(formVersionConfigSchema.safeParse(config(PREFIX + 'a'.repeat(n))).success).toBe(false);
  });
});

describe('fieldTarget — every legitimate target still parses', () => {
  it.each([
    ['none', 'the default'],
    ['email', 'a closed-set target'],
    ['firstName', 'a closed-set target'],
    ['custom:a', 'the shortest custom key'],
    ['custom:property_type', 'an ordinary custom key'],
    [LONGEST_VALID, 'the longest key the CRM accepts'],
  ])('accepts %j (%s)', (target) => {
    expect(formVersionConfigSchema.safeParse(config(target)).success).toBe(true);
  });

  it('accepts exactly as much as a custom field key can hold, and no more', () => {
    // The cap is derived from `CUSTOM_FIELD_KEY_MAX_LENGTH`, not chosen. A
    // target that cannot name a key a workspace has created is a mapping the
    // operator cannot make, so this boundary is the point of the number.
    const atLimit = PREFIX + 'a'.repeat(CUSTOM_FIELD_KEY_MAX_LENGTH);
    const overLimit = PREFIX + 'a'.repeat(CUSTOM_FIELD_KEY_MAX_LENGTH + 1);

    expect(formVersionConfigSchema.safeParse(config(atLimit)).success).toBe(true);
    expect(formVersionConfigSchema.safeParse(config(overLimit)).success).toBe(false);
  });

  it('still refuses a malformed key of legal length', () => {
    // The cap must not have replaced the shape check.
    for (const bad of [
      'custom:',
      'custom:1abc',
      'custom:Abc',
      'custom:a-b',
      'custom:a b',
      'nope',
    ]) {
      expect(formVersionConfigSchema.safeParse(config(bad)).success, bad).toBe(false);
    }
  });
});

describe('⚠️ fieldTarget — the regex is bounded, not merely the string', () => {
  /**
   * Dev log 0018 found that zod v4 runs every check and collects all issues, so
   * `.max()` bounds what is ACCEPTED and never what is EXAMINED. Re-measured on
   * zod 4.4.3: both issues fire, which is the proof that adding `.max()` alone
   * would have left the pattern running against the full input.
   */
  it('runs the pattern even though .max() has already failed', () => {
    const result = formVersionConfigSchema.safeParse(config(PREFIX + 'a'.repeat(200_000)));

    expect(result.success).toBe(false);
    if (result.success) return;

    const codes = result.error.issues.map((issue) => issue.code);
    expect(codes).toContain('too_big');
    expect(codes).toContain('invalid_format');
  });

  it('costs the same on a 4 MB target as on a 4 KB one', () => {
    // The strong property, and the reason the quantifier is `{0,47}` rather
    // than `*`. Anchored with a finite bound, the engine tries one start
    // offset, consumes at most 55 characters and gives up — so cost is
    // independent of input length rather than merely cheap.
    //
    // Measured while writing this (dev log 0027): 672.6x with `*`, 1.3x with
    // `{0,47}`, for the same 1000x increase in input. The threshold sits an
    // order of magnitude clear of both, so it is a shape assertion rather than
    // a benchmark — it fails if someone restores an unbounded quantifier and
    // passes under ordinary CI noise.
    const measure = (size: number, iterations: number): number => {
      const value = config(PREFIX + 'a'.repeat(size));
      const started = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) formVersionConfigSchema.safeParse(value);
      return Number(process.hrtime.bigint() - started) / iterations;
    };

    measure(4_000, 200); // warm the JIT so the first measurement is not the outlier

    const small = measure(4_000, 500);
    const large = measure(4_000_000, 50);

    expect(large / small).toBeLessThan(20);
  });
});
