/**
 * Contact detail — identity, provenance, timeline, deals and tasks.
 *
 * IDOR DEFENCE: the `id` route parameter goes straight to `getContact`, which
 * resolves it THROUGH the tenant. A contact belonging to another workspace
 * produces a NotFoundError → 404, never a 403 that would confirm the record
 * exists somewhere.
 *
 * The timeline is the point of this page. It is thin today and becomes the
 * product's most valuable surface as calls, appointments and revenue land.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { isAppError } from '@growth-os/contracts';
import {
  getContact,
  listAcquisitionsForContact,
  listActivities,
  listOpportunities,
} from '@growth-os/crm';
import { Badge, Surface } from '@growth-os/ui';
import { requireAuthContext } from '../../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../../server/crm-server';
import { ActivityTimeline } from '../../../../../components/crm/activity-timeline';
import { SourceSummary } from '../../../../../components/crm/source-badge';
import { WorkspaceRequired } from '../../../../../components/crm/workspace-required';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const { actor, workspace } = await requireAuthContext();
  if (!workspace) return { title: 'Contact' };

  try {
    const contact = await getContact(buildServerCrmContext(actor, workspace), id);
    return { title: contact.displayName };
  } catch {
    return { title: 'Contact' };
  }
}

function formatMinor(valueMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(valueMinor / 100);
}

export default async function ContactDetailPage({ params }: Params) {
  const { id } = await params;
  const { actor, workspace } = await requireAuthContext(`/customers/contacts/${id}`);
  if (!workspace) return <WorkspaceRequired />;

  const crm = buildServerCrmContext(actor, workspace);

  // A NotFoundError here means "not in YOUR workspace" — rendered as a plain
  // 404 so the response is identical whether the record exists elsewhere or
  // not at all.
  let contact;
  try {
    contact = await getContact(crm, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }

  const [timeline, acquisitions, deals] = await Promise.all([
    listActivities(crm, { contactId: id, limit: 25 }),
    listAcquisitionsForContact(crm, id),
    listOpportunities(crm, { limit: 25 }),
  ]);

  const contactDeals = deals.items.filter((deal) => deal.contactId === id);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <nav aria-label="Breadcrumb">
        <Link
          href="/customers/contacts"
          className="text-caption text-text-muted transition-colors duration-[120ms] hover:text-text focus-visible:outline-none"
        >
          ← Contacts
        </Link>
      </nav>

      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-h1 tracking-tight text-text">{contact.displayName}</h1>
            {contact.companyName ? (
              <p className="mt-1 text-body text-text-muted">{contact.companyName}</p>
            ) : null}
          </div>
          {contact.openOpportunityCount > 0 ? (
            <Badge tone="signal">{contact.openOpportunityCount} open</Badge>
          ) : null}
        </div>

        <Surface level={1} className="grid grid-cols-1 gap-x-8 gap-y-4 p-5 sm:grid-cols-2">
          <Detail label="Email">
            {contact.email ? (
              <a href={`mailto:${contact.email}`} className="text-text hover:text-signal">
                {contact.email}
              </a>
            ) : (
              <span className="text-text-subtle">Not provided</span>
            )}
          </Detail>

          <Detail label="Phone">
            {contact.phone ? (
              // tel: uses the E.164 form when available so the dialler works
              // regardless of how the number was typed.
              <a
                href={`tel:${contact.phoneE164 ?? contact.phone}`}
                className="text-text hover:text-signal"
              >
                {contact.phone}
              </a>
            ) : (
              <span className="text-text-subtle">Not provided</span>
            )}
          </Detail>

          <Detail label="Owner">
            <span className="text-text">{contact.ownerName ?? 'Unassigned'}</span>
          </Detail>

          <Detail label="First touch">
            <SourceSummary source={contact.firstSource} />
          </Detail>
        </Surface>
      </header>

      {/* Every recorded arrival, not just the first — the reason provenance
          lives on acquisitions rather than on the person (ADR-0011). */}
      {acquisitions.length > 0 ? (
        <section aria-labelledby="acquisitions-heading" className="flex flex-col gap-3">
          <h2 id="acquisitions-heading" className="text-overline text-text-subtle uppercase">
            How they reached you ({acquisitions.length})
          </h2>
          <Surface level={1} className="divide-y divide-line p-0">
            {acquisitions.map((acquisition) => (
              <div
                key={acquisition.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3"
              >
                <span className="text-body text-text">
                  {acquisition.sourceType.replace(/_/g, ' ')}
                </span>
                {acquisition.landingPath ? (
                  <code className="font-mono text-caption text-text-muted">
                    {acquisition.landingPath}
                  </code>
                ) : null}
                {acquisition.channelDetail ? (
                  <span className="text-caption text-text-muted">{acquisition.channelDetail}</span>
                ) : null}
                {/* Only shown when a source system actually declared it.
                    Never inferred — see ADR-0012. */}
                {acquisition.searchQuery ? (
                  <span className="text-caption text-signal">“{acquisition.searchQuery}”</span>
                ) : null}
                {acquisition.qualifiedAt ? <Badge tone="signal">Qualified</Badge> : null}
                <time
                  dateTime={acquisition.capturedAt}
                  className="ml-auto font-mono text-caption text-text-subtle tabular-nums"
                >
                  {new Date(acquisition.capturedAt).toLocaleDateString('en-AU')}
                </time>
              </div>
            ))}
          </Surface>
        </section>
      ) : null}

      {contactDeals.length > 0 ? (
        <section aria-labelledby="deals-heading" className="flex flex-col gap-3">
          <h2 id="deals-heading" className="text-overline text-text-subtle uppercase">
            Opportunities
          </h2>
          <Surface level={1} className="divide-y divide-line p-0">
            {contactDeals.map((deal) => (
              <div key={deal.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                <span className="text-body text-text">{deal.title}</span>
                <Badge
                  tone={
                    deal.status === 'won'
                      ? 'signal'
                      : deal.status === 'lost'
                        ? 'critical'
                        : 'neutral'
                  }
                >
                  {deal.stageName}
                </Badge>
                <span className="ml-auto font-mono text-body text-text tabular-nums">
                  {formatMinor(deal.estimatedValueMinor, deal.currency)}
                </span>
              </div>
            ))}
          </Surface>
        </section>
      ) : null}

      <section aria-labelledby="timeline-heading" className="flex flex-col gap-3">
        <h2 id="timeline-heading" className="text-overline text-text-subtle uppercase">
          Timeline
        </h2>
        <Surface level={1} className="p-5">
          <ActivityTimeline activities={timeline.items} />
        </Surface>
      </section>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption text-text-subtle">{label}</span>
      <span className="text-body">{children}</span>
    </div>
  );
}
