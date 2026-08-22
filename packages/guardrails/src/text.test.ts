/**
 * The text reduction, including what a model can do to it.
 *
 * `agent_outputs.content` is model-produced `jsonb`. AGENTS.md §6 requires
 * hostile-input tests for anything parsing the outside world, and a language
 * model's output is exactly that: not malicious, but unbounded and
 * unvalidated in shape.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  MAX_NODES,
  MAX_TEXT_LENGTH,
  extractText,
  fingerprint,
  jaccard,
  shingle,
  toWords,
} from './text';

describe('extractText', () => {
  it('collects strings from nested objects and arrays', () => {
    const text = extractText({
      title: 'Boiler servicing',
      sections: [{ body: 'Winter is coming' }, { body: 'Book early' }],
    });
    expect(text).toContain('Boiler servicing');
    expect(text).toContain('Winter is coming');
    expect(text).toContain('Book early');
  });

  it('⚠️ is deterministic regardless of key order', () => {
    // Two spellings of the same document must fingerprint identically, or
    // duplication detection depends on JSON serialisation order.
    const a = extractText({ alpha: 'one', beta: 'two', gamma: 'three' });
    const b = extractText({ gamma: 'three', alpha: 'one', beta: 'two' });
    expect(a).toBe(b);
  });

  it('⚠️ ignores keys, so two drafts sharing a schema are not similar', () => {
    // If key names were collected, every `{title, body}` output would share
    // two tokens with every other one purely for having the same shape.
    const text = extractText({ headline: 'zebra', subheading: 'quokka' });
    expect(text).not.toContain('headline');
    expect(text).not.toContain('subheading');
    expect(text).toContain('zebra');
  });

  it('ignores numbers and booleans', () => {
    // A price or a flag matching across two drafts says nothing about reuse.
    expect(extractText({ price: 4995, featured: true, copy: 'text' }).trim()).toBe('text');
  });

  it('handles null, undefined and primitives without throwing', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
    expect(extractText(42)).toBe('');
    expect(extractText('bare string')).toBe('bare string');
  });

  describe('hostile input', () => {
    it('⚠️ a self-referencing object terminates instead of overflowing the stack', () => {
      const cyclic: Record<string, unknown> = { copy: 'hello' };
      cyclic['self'] = cyclic;
      cyclic['nested'] = { parent: cyclic, copy: 'world' };

      const text = extractText(cyclic);
      expect(text).toContain('hello');
      expect(text).toContain('world');
    });

    it('an array containing itself terminates', () => {
      const cyclic: unknown[] = ['edge'];
      cyclic.push(cyclic);
      expect(extractText(cyclic)).toContain('edge');
    });

    it('nesting far deeper than MAX_DEPTH terminates', () => {
      let deep: Record<string, unknown> = { copy: 'bottom' };
      for (let i = 0; i < MAX_DEPTH * 10; i += 1) deep = { child: deep };
      // The bottom is beyond the limit and is simply not collected; the point
      // is that it returns at all.
      expect(() => extractText(deep)).not.toThrow();
    });

    it('a very wide structure stops at MAX_NODES', () => {
      const wide = Array.from({ length: MAX_NODES * 2 }, (_, i) => `word${i}`);
      const text = extractText(wide);
      expect(text.length).toBeGreaterThan(0);
      expect(text.split(' ').length).toBeLessThanOrEqual(MAX_NODES);
    });

    it('⚠️ a megabyte of one string is truncated to MAX_TEXT_LENGTH', () => {
      const huge = { copy: 'a'.repeat(MAX_TEXT_LENGTH * 5) };
      expect(extractText(huge).length).toBe(MAX_TEXT_LENGTH);
    });

    it('total collected length is capped across many strings, not just one', () => {
      const many = Array.from({ length: 500 }, () => 'x'.repeat(1000));
      expect(extractText(many).length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    });
  });
});

describe('toWords', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(toWords('  Hello,   WORLD!!  ')).toEqual(['hello', 'world']);
  });

  it('folds accents so café and cafe are one word', () => {
    expect(toWords('café')).toEqual(toWords('cafe'));
  });

  it('keeps digits, which carry meaning in marketing copy', () => {
    expect(toWords('24/7 callout')).toEqual(['24', '7', 'callout']);
  });

  it('handles non-Latin scripts without discarding them', () => {
    expect(toWords('東京 サービス').length).toBe(2);
  });

  it('an empty or punctuation-only string yields no words', () => {
    expect(toWords('')).toEqual([]);
    expect(toWords('!!! ... ???')).toEqual([]);
  });
});

describe('shingle', () => {
  it('produces overlapping n-grams', () => {
    expect([...shingle(['a', 'b', 'c', 'd'], 3)]).toEqual(['a b c', 'b c d']);
  });

  it('⚠️ text shorter than one shingle becomes a single whole-text shingle', () => {
    // Returning an empty set here would score two IDENTICAL headlines as 0%
    // similar, which is the case duplication detection most needs to catch.
    expect([...shingle(['short', 'headline'], 3)]).toEqual(['short headline']);
  });

  it('no words yields no shingles', () => {
    expect(shingle([], 3).size).toBe(0);
  });

  it('repeated phrases collapse, because a Set is the right model', () => {
    // "buy now buy now" should not count as twice as similar to "buy now".
    // ⚠️ 2, not 3 — this assertion was written wrong and the code was right.
    // The windows are "buy now", "now buy", "buy now"; the first and third are
    // the same string, so the Set holds two.
    expect(shingle(['buy', 'now', 'buy', 'now'], 2).size).toBe(2);
  });
});

describe('jaccard', () => {
  it('identical sets score 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('disjoint sets score 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('half-overlapping sets score between', () => {
    // |∩| = 1, |∪| = 3
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 10);
  });

  it('⚠️ two empty documents score 0, not 1', () => {
    // 0/0 has no arithmetic answer. Scoring 1 would turn every agent that
    // produced nothing into a duplication incident.
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('is symmetric', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd', 'e']);
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});

describe('fingerprint', () => {
  it('reduces a whole content object to shingles', () => {
    const print = fingerprint({ body: 'the quick brown fox jumps' });
    expect(print.has('the quick brown')).toBe(true);
    expect(print.has('quick brown fox')).toBe(true);
  });

  it('the same prose in a different structure fingerprints identically', () => {
    // Structure is not content: the same sentence split across fields is the
    // same sentence.
    const flat = fingerprint({ body: 'emergency plumber available today' });
    const split = fingerprint({ a: 'emergency plumber', b: 'available today' });
    expect(jaccard(flat, split)).toBeGreaterThan(0.5);
  });
});
