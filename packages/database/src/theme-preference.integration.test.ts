/**
 * The theme preference column, against a real database.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * Both properties that matter are the database's. That an existing row gets
 * `dark` is the DEFAULT backfilling during migration, not application code.
 * That an invalid theme is impossible is the ENUM refusing it — §5 puts limits
 * in the database, and §6 says the test for a constraint is a row that must be
 * refused.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestHarness, hasTestDatabase, type TestHarness } from './testing/harness';
import { users } from './schema/identity';
import { DEFAULT_THEME_PREFERENCE, THEME_PREFERENCES } from '@growth-os/contracts';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

describeIntegration('users.theme_preference', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
  });

  async function newUser(email = 'sam@example.test'): Promise<string> {
    const [row] = await harness.owner
      .insert(users)
      .values({ email, name: 'Sam', passwordHash: null })
      .returning();
    return row!.id;
  }

  it('a user created without naming a theme gets the current default', async () => {
    // ⚠️ THIS ASSERTED `dark` UNTIL ADR-0057 MOVED THE DEFAULT TO
    // `growth-bright`. It is updated rather than deleted, and it is deliberately
    // pinned to the literal as well as the constant: asserting only
    // `DEFAULT_THEME_PREFERENCE` would pass even if the column default and the
    // application constant had drifted apart, which is the one failure this is
    // here to catch.
    const id = await newUser();
    const [row] = await harness.owner.select().from(users).where(eq(users.id, id));
    expect(row?.themePreference).toBe('growth-bright');
    expect(row?.themePreference).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it('⚠️ CHANGING THE DEFAULT DOES NOT MOVE AN ACCOUNT THAT ALREADY EXISTS', async () => {
    // The compatibility guarantee of ADR-0057, proven end to end against a real
    // ALTER rather than argued from SQL semantics.
    //
    // A DEFAULT applies only to an INSERT that omits the column, and this
    // column is NOT NULL — so everyone is stored explicitly. Someone on `dark`
    // stays on `dark` when the product's default changes underneath them.
    const existing = await newUser('already-here@example.test');
    await harness.owner
      .update(users)
      .set({ themePreference: 'dark' })
      .where(eq(users.id, existing));

    // Move the default again, exactly as migration 0013 did.
    await harness.owner.execute(
      sql`ALTER TABLE users ALTER COLUMN theme_preference SET DEFAULT 'growth-warm'`,
    );

    try {
      const created = await newUser('brand-new@example.test');

      const [before] = await harness.owner.select().from(users).where(eq(users.id, existing));
      const [after] = await harness.owner.select().from(users).where(eq(users.id, created));

      expect(before?.themePreference, 'an existing account was re-themed').toBe('dark');
      expect(after?.themePreference, 'a new account did not get the new default').toBe(
        'growth-warm',
      );
    } finally {
      // Leave the schema as the migrations left it, whatever happened above.
      await harness.owner.execute(
        sql`ALTER TABLE users ALTER COLUMN theme_preference SET DEFAULT 'growth-bright'`,
      );
    }
  });

  it('the column is NOT NULL, so no row can mean "no opinion"', async () => {
    const [column] = await harness.owner.execute<{ is_nullable: string }>(sql`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'theme_preference'
    `);
    expect(column?.is_nullable).toBe('NO');
  });

  it.each(THEME_PREFERENCES)('accepts %s', async (theme) => {
    const id = await newUser(`${theme}@example.test`);
    await harness.owner.update(users).set({ themePreference: theme }).where(eq(users.id, id));
    const [row] = await harness.owner.select().from(users).where(eq(users.id, id));
    expect(row?.themePreference).toBe(theme);
  });

  it('⚠️ REFUSES a theme that is not in the enum', async () => {
    // The constraint test §6 asks for: a row that must be refused. Application
    // validation can be bypassed by any future route that forgets it; this
    // cannot. Raw SQL, because the typed client would not let us try.
    const id = await newUser();
    await expect(
      harness.owner.execute(
        sql`UPDATE users SET theme_preference = 'solarized' WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow();

    // And it is still whatever it was, not silently coerced. Pinned to the
    // constant rather than a literal: what this asserts is "unchanged", and
    // hard-coding the default here made it fail for the wrong reason when
    // ADR-0057 moved it.
    const [row] = await harness.owner.select().from(users).where(eq(users.id, id));
    expect(row?.themePreference).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it('⚠️ refuses a theme that LOOKS like one of ours', async () => {
    // `growth` and `growth-light` are the plausible typos now that three of the
    // five values share a prefix. A near-miss must be refused exactly as hard
    // as nonsense is.
    const id = await newUser('typo@example.test');
    for (const wrong of ['growth', 'growth-light', 'Growth-Bright', 'growthbright']) {
      await expect(
        harness.owner.execute(
          sql`UPDATE users SET theme_preference = ${wrong} WHERE id = ${id}::uuid`,
        ),
        `${wrong} was accepted`,
      ).rejects.toThrow();
    }
  });

  it('the enum in the database is exactly the contracts list', async () => {
    // The two would only disagree in production, as a refused write. Same shape
    // as the crawl enum agreement the frontier suite asserts.
    const rows = await harness.owner.execute<{ value: string }>(sql`
      SELECT unnest(enum_range(NULL::theme_preference))::text AS value
    `);
    expect(rows.map((row) => row.value).sort()).toEqual([...THEME_PREFERENCES].sort());
  });
});
