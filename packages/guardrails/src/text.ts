/**
 * Turning an agent's output into something two documents can be compared by.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * `agent_outputs.content` is `jsonb` whose shape varies by `kind` — a blog
 * outline, an ad variant and an email draft have nothing structural in common.
 * Duplication is a property of the PROSE, not of the JSON shape, so everything
 * here reduces an arbitrary value to a comparable bag of word shingles.
 *
 * ⚠️ THIS PARSES MODEL OUTPUT, WHICH IS UNTRUSTED INPUT.
 * A model can emit an object nested a thousand deep, a megabyte of one
 * repeated character, or a structure that references itself once it has been
 * through a caching layer. A naive recursive walk over any of those is a
 * crash, not a finding. Every traversal here is bounded in depth, in node
 * count and in collected length, and cycles are detected rather than followed.
 *
 * @see docs/decisions/ADR-0064-self-duplication-guardrail.md
 */

/** Deepest object/array nesting walked before the rest of a branch is ignored. */
export const MAX_DEPTH = 32;

/** Most values visited in one extraction, across the whole structure. */
export const MAX_NODES = 10_000;

/**
 * Most characters collected from one document.
 *
 * Comparison cost is linear in this, and prose long enough to matter for
 * duplication is far shorter. A model emitting more than this is not producing
 * a marketing draft.
 */
export const MAX_TEXT_LENGTH = 200_000;

/** Words per shingle. See ADR-0064 for why 3 rather than 1 or 5. */
export const SHINGLE_SIZE = 3;

/**
 * Collect every string in a JSON-ish value, in a deterministic order.
 *
 * Object keys are sorted so that `{a, b}` and `{b, a}` — which are the same
 * document — produce the same text. Keys themselves are NOT collected: a
 * field named `title` is structure, not content, and including it would make
 * two unrelated drafts look similar for sharing a schema.
 */
export function extractText(value: unknown): string {
  const parts: string[] = [];
  let nodes = 0;
  let collected = 0;
  const seen = new WeakSet<object>();

  function walk(current: unknown, depth: number): void {
    if (nodes >= MAX_NODES || collected >= MAX_TEXT_LENGTH || depth > MAX_DEPTH) return;
    nodes += 1;

    if (typeof current === 'string') {
      // ⚠️ The separator counts against the cap. Measured, not assumed: without
      // this, 500 strings of 1000 characters returned 200,199 characters from a
      // 200,000 cap, because `join(' ')` adds a space the accounting never saw.
      // A cap that bounds an intermediate rather than the returned value is not
      // a cap.
      const separator = parts.length > 0 ? 1 : 0;
      const remaining = MAX_TEXT_LENGTH - collected - separator;
      if (remaining <= 0) return;
      const piece = current.length > remaining ? current.slice(0, remaining) : current;
      parts.push(piece);
      collected += piece.length + separator;
      return;
    }

    // Numbers and booleans are deliberately ignored. A price or a flag that
    // happens to match across two drafts says nothing about whether the prose
    // was reused, and including them makes short structured outputs collide.
    if (current === null || typeof current !== 'object') return;

    // ⚠️ A cycle would otherwise recurse until the stack dies. Model output
    // arrives as parsed JSON and cannot contain one, but this function is also
    // reachable from in-memory objects that can.
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) walk(item, depth + 1);
      return;
    }

    for (const key of Object.keys(current as Record<string, unknown>).sort()) {
      walk((current as Record<string, unknown>)[key], depth + 1);
    }
  }

  walk(value, 0);
  return parts.join(' ');
}

/**
 * Reduce text to comparable words.
 *
 * Case, punctuation, accents and whitespace runs all disappear, because none
 * of them is the difference between "we wrote this again" and "we wrote
 * something new". NFKD + combining-mark strip means `café` and `cafe` are one
 * word rather than two.
 */
export function toWords(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      // Latin diacritics only. ⚠️ NFKD also splits Japanese voiced kana — `ビ`
      // becomes `ヒ` + U+3099 — and U+3099 survives this strip, so the NFKC
      // below recomposes it. Without that step the surviving mark is not
      // `\p{L}`, so it acted as a word separator and cut `サービス` in half.
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(' ')
      .filter((word) => word.length > 0)
  );
}

/**
 * Overlapping word n-grams.
 *
 * ⚠️ A document shorter than one shingle becomes a SINGLE shingle of its whole
 * word list, rather than none. Returning an empty set for short text would
 * make every headline compare as 0% similar to every other headline —
 * including an identical one, which is the case that matters most.
 */
export function shingle(words: readonly string[], size: number = SHINGLE_SIZE): Set<string> {
  const shingles = new Set<string>();
  if (words.length === 0) return shingles;

  if (words.length <= size) {
    shingles.add(words.join(' '));
    return shingles;
  }

  for (let index = 0; index + size <= words.length; index += 1) {
    shingles.add(words.slice(index, index + size).join(' '));
  }
  return shingles;
}

/**
 * Jaccard similarity: |intersection| / |union|, in [0, 1].
 *
 * ⚠️ TWO EMPTY DOCUMENTS SCORE 0, NOT 1.
 * `0/0` has no arithmetic answer, so the choice is ours. Scoring 1 would make
 * every empty output a "duplicate" of every other empty output, turning an
 * agent that produced nothing into a duplication incident. An empty draft is a
 * different problem, and it is not this check's job to report it.
 */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;

  // Iterate the smaller set: the intersection is the same either way, and this
  // keeps the cost proportional to the shorter document.
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];

  let intersection = 0;
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }

  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** The whole reduction, from an arbitrary `content` value to its shingles. */
export function fingerprint(value: unknown): Set<string> {
  return shingle(toWords(extractText(value)));
}
