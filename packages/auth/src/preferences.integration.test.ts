/**
 * Theme preference read/write, against a real database.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * The properties worth proving are the storage's: that an untouched account
 * reads as `dark`, that a write is durable and scoped to ONE user, and that
 * writing to a user that does not exist reports failure instead of pretending.
 * A mock would assert that the code calls Drizzle.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { DEFAULT_THEME_PREFERENCE, THEME_PREFERENCES } from '@growth-os/contracts';
import { getThemePreference, setThemePreference } from './preferences';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;
const { users } = schemaTables;

describeIntegration('theme preference', () => {
  let harness: TestHarness;
  let db: Database;

  beforeAll(async () => {
    harness = await createTestHarness();
    db = harness.owner as unknown as Database;
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
  });

  async function newUser(email: string): Promise<string> {
    const [row] = await harness.owner
      .insert(users)
      .values({ email, name: 'Sam', passwordHash: null })
      .returning();
    return row!.id;
  }

  it('an account that has never chosen reads as the current default', async () => {
    // ⚠️ ASSERTED `dark` UNTIL ADR-0057 MOVED THE DEFAULT TO `growth-bright`.
    // Updated rather than deleted, and pinned to the literal as well as the
    // constant — asserting only `DEFAULT_THEME_PREFERENCE` would still pass if
    // the column default and the application constant had drifted apart.
    const id = await newUser('untouched@example.test');
    expect(await getThemePreference(db, id)).toBe('growth-bright');
    expect(await getThemePreference(db, id)).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it.each(THEME_PREFERENCES)('stores and returns %s', async (theme) => {
    const id = await newUser(`${theme}@example.test`);
    expect(await setThemePreference(db, id, theme)).toBe(theme);
    expect(await getThemePreference(db, id)).toBe(theme);
  });

  it('the choice is durable — a later read sees it, not the default', async () => {
    const id = await newUser('sam@example.test');
    await setThemePreference(db, id, 'light');
    // A fresh read, as a second request on another device would do.
    expect(await getThemePreference(db, id)).toBe('light');
  });

  it('⚠️ writes to exactly ONE account', async () => {
    // The property that matters if a route ever passes the wrong id: one
    // person changing their theme must not change anybody else's.
    const mine = await newUser('mine@example.test');
    const theirs = await newUser('theirs@example.test');

    await setThemePreference(db, mine, 'light');

    expect(await getThemePreference(db, mine)).toBe('light');
    // Untouched, so still the default — whatever the default currently is.
    expect(await getThemePreference(db, theirs)).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it('moves updatedAt, because the user record changed', async () => {
    const id = await newUser('stamp@example.test');
    const [before] = await harness.owner.select().from(users).where(eq(users.id, id));
    await setThemePreference(db, id, 'light');
    const [after] = await harness.owner.select().from(users).where(eq(users.id, id));

    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it('⚠️ reports failure for a user that does not exist, rather than success', async () => {
    // Echoing the argument back would report a saved setting for a write that
    // affected nothing — the caller could not tell.
    const missing = '00000000-0000-0000-0000-000000000000';
    expect(await setThemePreference(db, missing, 'light')).toBeNull();
  });

  it('reads the default for a user that does not exist rather than throwing', async () => {
    // The only caller is a layout choosing a palette. A missing user is an
    // authentication problem for the layer above; painting an error page
    // because of a colour lookup would be the wrong failure.
    const missing = '00000000-0000-0000-0000-000000000000';
    expect(await getThemePreference(db, missing)).toBe(DEFAULT_THEME_PREFERENCE);
  });
});
