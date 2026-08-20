import 'server-only';

/**
 * Resolving the theme for one request.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Answer "which palette does this response paint?" on the server, before a
 * single byte of HTML is written, so the browser never renders the wrong one.
 *
 * ⚠️ NO FLASH, AND NO INLINE SCRIPT EITHER.
 * The usual fix for theme flashing is a blocking `<script>` in `<head>` that
 * reads `localStorage` and sets `data-theme` before paint. That pattern exists
 * to solve a problem this product does not have: a preference only the browser
 * knows. Here it lives on the account, and the server is already resolving the
 * session to render the page — so the correct attribute is in the FIRST byte of
 * HTML. There is no window in which the wrong theme is painted, nothing to
 * suppress, and no third copy of the theme vocabulary inside a stringified
 * script.
 *
 * ⚠️ IT VALIDATES THE SESSION BUT DOES NOT RESOLVE THE ACTOR.
 * `getAuthContext` also calls `resolveActor`, which joins memberships and
 * agencies — real work, and none of it needed to choose a colour. The root
 * layout runs on EVERY route including the public form pages, so this takes the
 * narrow path deliberately: one session lookup, one theme lookup.
 *
 * ⚠️ IT IS NOT AN AUTHORIZATION BOUNDARY and must never become one. It returns
 * a palette. `(app)/layout.tsx` is what decides whether a person may see the
 * page at all, and nothing here should ever be used to answer that.
 *
 * @see docs/decisions/ADR-0056-user-theme-preference.md
 */

import { cookies } from 'next/headers';
import { getThemePreference, SESSION_COOKIE_NAME, validateSession } from '@growth-os/auth';
import { DEFAULT_THEME_PREFERENCE, type ThemePreference } from '@growth-os/contracts';
import { getDependencies } from './dependencies';

/**
 * The theme for the current request.
 *
 * Signed out — the login page, a public hosted form — there is no preference to
 * apply and the answer is the default, exactly as before this existed.
 *
 * Never throws. A failure here must not take down a page: a database that
 * cannot answer a colour question still renders, in the default theme —
 * `growth-bright` since ADR-0057. This said "in dark" until the rendered login
 * page was observed (dev log 0040).
 */
export async function resolveRequestTheme(): Promise<ThemePreference> {
  try {
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!token) return DEFAULT_THEME_PREFERENCE;

    const { db, sessionConfig } = getDependencies();
    const session = await validateSession(db, token, sessionConfig);
    if (!session) return DEFAULT_THEME_PREFERENCE;

    return await getThemePreference(db, session.userId);
  } catch {
    // Deliberately swallowed. This runs in the ROOT layout, so throwing would
    // replace every page in the product — including the login page someone
    // needs in order to fix whatever is broken — with an error screen, over a
    // colour scheme.
    return DEFAULT_THEME_PREFERENCE;
  }
}
