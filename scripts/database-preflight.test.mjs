/**
 * The preflight's verdicts — the part that must never learn to say "fine".
 *
 * WHY THIS EXISTS
 * `verify:e2e` is the one gate in this project that MUST fail when it cannot
 * run (AGENTS.md §7). The classification below is where that promise could
 * quietly break: one `return { ok: true }` on an unrecognised error, or a
 * `catch` that swallows, and the browser gate goes green having run no browser.
 *
 * The live behaviour is proven by pointing the real script at wrong databases
 * (dev log 0046). These tests pin the reasoning, and they run in `verify:all`
 * where no database exists — which is the point, because the defect they guard
 * against is silence, not a wrong connection.
 *
 * @see docs/development-log/0046-a-preflight-that-lied.md
 */

import { describe, expect, it } from 'vitest';
import {
  connectionTarget,
  describeDatabaseFailure,
  describeMissingCreatePrivilege,
} from './database-preflight.mjs';

const target = {
  hostPort: '127.0.0.1:5432',
  user: 'growth_os',
  database: 'growth_os_test',
};

/** Every code the script names individually, and what it must be about. */
const KNOWN = [
  ['28P01', /authentication failed/i],
  ['28000', /rejected the role/i],
  ['3D000', /does not exist/i],
  ['ECONNREFUSED', /nothing is listening/i],
  ['ENOTFOUND', /does not resolve/i],
  ['ETIMEDOUT', /timed out/i],
  ['CONNECT_TIMEOUT', /timed out/i],
];

describe('every failure is reported as a failure', () => {
  it.each(KNOWN)('%s names the problem specifically', (code, expected) => {
    const { problem, remedy } = describeDatabaseFailure({ code }, target);
    expect(problem).toMatch(expected);
    expect(remedy.length, 'a problem with no remedy is half a message').toBeGreaterThan(20);
  });

  it('⚠️ an UNRECOGNISED error still produces a failure, never silence', () => {
    // The §7 invariant, asserted directly. If someone adds a "we do not know
    // what this is, carry on" branch, this fails.
    const { problem, remedy } = describeDatabaseFailure(
      { code: 'XX000', message: 'internal error' },
      target,
    );
    expect(problem).toBeTruthy();
    expect(problem).toContain('127.0.0.1:5432');
    expect(remedy, 'the driver detail must survive').toContain('internal error');
  });

  it('an error with no code at all is still reported', () => {
    const { problem, remedy } = describeDatabaseFailure(new Error('socket hang up'), target);
    expect(problem).toContain('no error code');
    expect(remedy).toContain('socket hang up');
  });

  it('⚠️ reads the code from `cause`, which is where the driver puts it', () => {
    // postgres.js wraps: the SQLSTATE arrives on `error.cause.code`, not on the
    // error itself. Missing this would classify every real failure as unknown.
    const { problem } = describeDatabaseFailure({ cause: { code: '28P01' } }, target);
    expect(problem).toMatch(/authentication failed/i);
  });

  it('every known code produces a DISTINCT problem sentence', () => {
    // Two codes sharing wording would send a reader to the wrong remedy.
    const problems = KNOWN.map(([code]) => describeDatabaseFailure({ code }, target).problem);
    const distinct = new Set(problems.filter((p) => !/timed out/.test(p)));
    expect(distinct.size).toBe(problems.filter((p) => !/timed out/.test(p)).length);
  });
});

describe('the CREATE-privilege verdict', () => {
  it('names the role, the database, and what migrate needs', () => {
    const { problem, remedy } = describeMissingCreatePrivilege(target);
    expect(problem).toContain('growth_os');
    expect(problem).toContain('growth_os_test');
    expect(problem).toMatch(/cannot CREATE/);
    // The remedy must point at the actual distinction, not just say "denied".
    expect(remedy).toMatch(/CREATE SCHEMA drizzle/);
    expect(remedy).toMatch(/create-app-role\.sql/);
  });
});

describe('connectionTarget', () => {
  it('extracts host, port, user and database', () => {
    const t = connectionTarget(new URL('postgresql://sam:pw@db.test:6543/growth_os'));
    expect(t).toEqual({ hostPort: 'db.test:6543', user: 'sam', database: 'growth_os' });
  });

  it("defaults the port to PostgreSQL's, so a message never says `:`", () => {
    expect(connectionTarget(new URL('postgresql://sam:pw@db.test/x')).hostPort).toBe(
      'db.test:5432',
    );
  });

  it('decodes percent-encoded credentials', () => {
    // A password or role with an @ or / in it is percent-encoded in the URL;
    // printing the raw form would name a role nobody recognises.
    const t = connectionTarget(new URL('postgresql://my%40user:pw@db.test:5432/my%20db'));
    expect(t.user).toBe('my@user');
    expect(t.database).toBe('my db');
  });

  it('⚠️ never carries the password into a message', () => {
    const t = connectionTarget(new URL('postgresql://sam:hunter2@db.test:5432/growth_os'));
    expect(JSON.stringify(t)).not.toContain('hunter2');
  });
});
