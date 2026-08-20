/**
 * Appearance — a person's own settings, not the workspace's.
 *
 * ⚠️ NO CAPABILITY CHECK, AND THAT IS DELIBERATE.
 * Every other page under `(app)/system` configures the WORKSPACE, so each gates
 * on a capability — a member inventing a tag vocabulary affects everyone. A
 * theme affects one pair of eyes. Requiring a role to choose your own contrast
 * would be the kind of check that looks careful and is only an obstacle.
 *
 * There is also no workspace requirement: a user invited but not yet added to
 * any workspace still gets to decide how the product looks.
 */

import type { Metadata } from 'next';
import { requireAuthContext } from '../../../../server/auth-context';
import { getThemePreference } from '@growth-os/auth';
import { getDependencies } from '../../../../server/dependencies';
import { ThemeSetting } from '../../../../components/settings/theme-setting';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Appearance',
  description: 'How Growth OS looks on your account.',
};

export default async function AppearancePage() {
  const { actor } = await requireAuthContext('/system/appearance');

  // Read here rather than trusting the rendered `data-theme`: the attribute is
  // what the page was painted with, and the control must reflect what is
  // STORED. They agree today, and a control that reads the DOM would silently
  // stop being correct the moment they did not.
  const theme = await getThemePreference(getDependencies().db, actor.userId);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-h1 tracking-tight text-text">Appearance</h1>
        <p className="mt-1 text-body text-text-muted">
          How Growth OS looks for you. These settings are yours alone — nobody else in the workspace
          sees the change.
        </p>
      </header>

      <section className="rounded-xl border border-line bg-surface-1 p-6">
        <ThemeSetting initialTheme={theme} />
      </section>
    </div>
  );
}
