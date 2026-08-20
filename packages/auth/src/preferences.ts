/**
 * Per-account presentation preferences.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Read and write the settings that belong to a PERSON rather than to a
 * workspace or a browser. Today that is one field: which palette they see.
 *
 * ⚠️ DELIBERATELY NOT ON `Actor`, AND THAT IS THE DESIGN.
 * `Actor` is an authorization value — its own docblock says `workspaces` is
 * "the complete set the actor may touch", and every authorization decision is a
 * lookup in it. A theme is presentation. Widening a security-critical type with
 * a cosmetic field invites exactly the reasoning that ends with something
 * non-cosmetic being added next, and it would have meant touching 22 `Actor`
 * literals across 15 files (measured) for a colour scheme.
 *
 * ⚠️ THE CALLER SUPPLIES THE USER ID, AND IT MUST BE THE SESSION'S.
 * These functions do not authenticate. `setThemePreference` will happily write
 * to whichever user it is given, so a route MUST pass the id it resolved from
 * the session cookie and never one taken from a request body — that is the
 * difference between a settings endpoint and an account-takeover primitive.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { eq } from 'drizzle-orm';
import {
  DEFAULT_THEME_PREFERENCE,
  themePreferenceSchema,
  type ThemePreference,
} from '@growth-os/contracts';
import { schemaTables, type Database } from '@growth-os/database';

const { users } = schemaTables;

/**
 * The theme this account has chosen.
 *
 * Returns the default for a user that does not exist rather than throwing: the
 * only caller is a layout deciding which palette to paint, and a missing user
 * is an authentication problem for the layer above to handle. Rendering the
 * default beats rendering an error page because of a colour lookup.
 */
export async function getThemePreference(db: Database, userId: string): Promise<ThemePreference> {
  const [row] = await db
    .select({ themePreference: users.themePreference })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // The column is NOT NULL with a default, so this narrowing is for the
  // missing-row case and for a build reading a database migrated past it.
  return themePreferenceSchema.safeParse(row?.themePreference).data ?? DEFAULT_THEME_PREFERENCE;
}

/**
 * Record a theme choice. Returns what is now stored.
 *
 * ⚠️ RETURNS THE STORED ROW, NOT THE INPUT. A caller that echoed its own
 * argument back would report success for a write that affected nothing —
 * a user id that no longer exists, for instance. Zero rows returned is a
 * `null` the caller has to deal with.
 */
export async function setThemePreference(
  db: Database,
  userId: string,
  theme: ThemePreference,
): Promise<ThemePreference | null> {
  const [row] = await db
    .update(users)
    // `updatedAt` moves because this is a change to the user record, and a
    // row whose contents changed while its timestamp did not is the kind of
    // thing that makes an audit trail untrustworthy.
    .set({ themePreference: theme, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ themePreference: users.themePreference });

  return row ? (row.themePreference as ThemePreference) : null;
}
