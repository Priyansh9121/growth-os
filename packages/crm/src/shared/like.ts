/**
 * LIKE / ILIKE pattern construction.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * One definition of "turn what someone typed into a substring pattern". Three
 * call sites built it inline and all three carried the same defect, which is
 * the shape ADR-0044, ADR-0045 and ADR-0046 were each written about.
 *
 * ⚠️ THE ESCAPE CHARACTER MUST BE ESCAPED FIRST, AND IT WAS NOT.
 * The previous inline form was:
 *
 *     `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`
 *
 * which escapes the two LIKE metacharacters and **not the backslash that gives
 * them their meaning**. A term containing a backslash therefore produced a
 * pattern whose escapes landed on the wrong characters. Measured against the
 * running Postgres (ADR-0047), the inline form was wrong on 7 of 14 cases,
 * in both directions:
 *
 * | stored        | searched for  | correct | inline form         |
 * | ------------- | ------------- | ------- | ------------------- |
 * | `Sara\Jones`  | `Sara\Jones`  | found   | **not found**       |
 * | `SaraJones`   | `Sara\Jones`  | no      | **found**           |
 * | `Sara%`       | `a\`          | no      | **found**           |
 * | `C:\Users\sam`| `\Users\`     | found   | **not found**       |
 *
 * Not an injection defect: the pattern is passed as a bound parameter, never
 * interpolated into SQL text, and `x' or '1'='1` was measured returning no
 * match rather than breaking out. It is a correctness defect — and one of the
 * three copies was `countTracesOf`, the helper the integration suite uses to
 * prove GDPR erasure by searching for the old name. A verification helper that
 * under-reports fails in the direction that looks green.
 *
 * @see docs/decisions/ADR-0047-one-like-escaper.md
 */

/**
 * Characters that must be escaped inside a LIKE pattern.
 *
 * ⚠️ THE BACKSLASH IS IN THIS CLASS AND MUST STAY IN IT. `%` and `_` are the
 * wildcards; `\` is what makes an escape an escape, so a pattern that escapes
 * the wildcards without escaping the backslash mis-assigns every escape after
 * the first backslash a user typed.
 *
 * Order inside the class does not matter: `String.replace` does not rescan its
 * own output, so each source character is escaped exactly once. That is
 * asserted in `like.test.ts` rather than left as a claim, because it is the
 * assumption that would make a two-pass implementation double-escape.
 */
const LIKE_SPECIAL = /[\\%_]/g;

/**
 * Escape a user-supplied term for use inside a LIKE / ILIKE pattern.
 *
 * Returns the escaped term WITHOUT wildcards, for a caller that needs an
 * anchored match. Most callers want {@link containsPattern} instead.
 */
export function escapeLike(term: string): string {
  return term.replace(LIKE_SPECIAL, (match) => `\\${match}`);
}

/**
 * Build a "contains this text" pattern from what someone typed.
 *
 * The wrapping wildcards are added here rather than by the caller so that no
 * call site can escape correctly and then forget the `%`, or wrap correctly and
 * forget to escape. Both halves of the decision live in one place.
 *
 * ⚠️ Relies on PostgreSQL's default LIKE escape character, which is `\`. No
 * `ESCAPE` clause is emitted: Drizzle's `ilike()` helper cannot express one,
 * and the default is what ADR-0047's measurements were taken against.
 */
export function containsPattern(term: string): string {
  return `%${escapeLike(term)}%`;
}
