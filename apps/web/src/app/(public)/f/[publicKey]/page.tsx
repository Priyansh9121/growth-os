/**
 * The hosted public form at `/f/<publicKey>`.
 *
 * ⚠️ AN UNAUTHENTICATED PAGE. It is reachable by anyone, and it deliberately
 * reveals nothing beyond the form itself: no workspace name, no branding that
 * would identify the tenant, no internal identifiers.
 *
 * It is also the iframe's contents — the embed points at
 * `/f/<key>?embed=1`, so the hosted form and the embedded form are literally
 * the same page. Two implementations would drift, and the one nobody tests
 * would be the one on a customer's website.
 *
 * WHY IT IS ITS OWN ROUTE GROUP
 * `(public)` has no application shell, no navigation and no session lookup.
 * Rendering the authenticated layout here would ship the dashboard's
 * JavaScript to a stranger filling in a contact form.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolvePublicForm, toPublicView } from '@growth-os/forms';
import { getDependencies } from '../../../../server/dependencies';
import { FormRenderer } from '../../../../components/forms/form-renderer';
import { EmbedResizeReporter } from '../../../../components/forms/embed-resize-reporter';

export const dynamic = 'force-dynamic';

/**
 * Deliberately generic, and NOT indexed.
 *
 * A hosted form is a functional endpoint, not content. Letting search engines
 * index one would put a customer's enquiry form in results above their own
 * website, and would leak which businesses use Growth OS.
 */
export const metadata: Metadata = {
  title: 'Contact form',
  robots: { index: false, follow: false },
};

type Params = { params: Promise<{ publicKey: string }>; searchParams: Promise<{ embed?: string }> };

export default async function HostedFormPage({ params, searchParams }: Params) {
  const { publicKey } = await params;
  const { embed } = await searchParams;

  const form = await resolvePublicForm(getDependencies().db, publicKey);

  // A 404 for unknown, unpublished and archived alike. Distinguishing them
  // would let a caller map which keys were ever real.
  if (!form || form.status !== 'active') notFound();

  const view = toPublicView(form, publicKey);
  const embedded = embed === '1';

  return (
    <main
      data-theme={view.theme === 'auto' ? undefined : view.theme}
      className={embedded ? 'p-1' : 'mx-auto w-full max-w-md px-5 py-10'}
      // The accent is a validated hex from configuration, set as a CSS custom
      // property. A style ATTRIBUTE, which the CSP permits via
      // `style-src-attr` — never an injected stylesheet.
      style={view.accent ? ({ ['--color-signal' as string]: view.accent } as never) : undefined}
    >
      {embedded ? <EmbedResizeReporter formKey={publicKey} /> : null}

      {!embedded ? (
        <header className="mb-6">
          <h1 className="text-h2 tracking-tight text-text">{view.name}</h1>
        </header>
      ) : (
        // The embed's heading is visually hidden: the customer's own page
        // already has a heading above the iframe, and two would be redundant
        // visually while the document still needs one for screen readers.
        <h1 className="sr-only">{view.name}</h1>
      )}

      <FormRenderer form={view} submitUrl={`/api/public/forms/${publicKey}/submissions`} />
    </main>
  );
}
