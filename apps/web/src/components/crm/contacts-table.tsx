'use client';

/**
 * Contacts list.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The operator's primary CRM surface. Dense, fast and keyboard-navigable —
 * this is a screen someone opens forty times a day, so it follows the operator
 * side of the motion budget: micro and standard tiers only, no entrance
 * choreography (Principle 6).
 *
 * ACCESSIBILITY
 * A real `<table>` with `<th scope="col">`, not a grid of divs. Screen readers
 * announce row and column context for free, and the browser's own table
 * navigation works. A div-based "table" would need a pile of ARIA to reach the
 * same place, and would get it subtly wrong.
 *
 * Search is debounced and drives a server round trip — filtering the current
 * page client-side would silently search only the 25 rows already loaded,
 * which looks like a broken search rather than a paginated one.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Badge, Button, Skeleton, Surface } from '@growth-os/ui';
import type { ContactView, Page } from '@growth-os/contracts';
import { SourceBadge } from './source-badge';
import { CreateContactDialog } from './create-contact-dialog';

const SEARCH_DEBOUNCE_MS = 250;

interface ContactsTableProps {
  readonly initialPage: Page<ContactView>;
  readonly canCreate: boolean;
}

export function ContactsTable({ initialPage, canCreate }: ContactsTableProps) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(initialPage);
  const [items, setItems] = useState<readonly ContactView[]>(initialPage.items);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [, startTransition] = useTransition();

  /** Discards responses from superseded requests so a slow early search cannot overwrite a newer one. */
  const requestSeq = useRef(0);

  const fetchContacts = useCallback(async (searchTerm: string, cursor?: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set('query', searchTerm);
      if (cursor) params.set('cursor', cursor);

      const response = await fetch(`/api/crm/contacts?${params.toString()}`, {
        credentials: 'same-origin',
      });

      if (seq !== requestSeq.current) return; // Superseded.

      if (!response.ok) {
        setError('Could not load contacts.');
        return;
      }

      const body = (await response.json()) as Page<ContactView>;
      setPage(body);
      setItems((existing) => (cursor ? [...existing, ...body.items] : body.items));
    } catch {
      if (seq === requestSeq.current) setError('Could not reach the server.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // Debounced search. The first render is skipped so the server-rendered page
  // is not immediately replaced by an identical client fetch.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const timer = setTimeout(() => void fetchContacts(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, fetchContacts]);

  const isEmpty = items.length === 0 && !loading;

  const emptyMessage = useMemo(
    () =>
      query
        ? { title: 'No contacts match that search', body: `Nothing found for “${query}”.` }
        : {
            title: 'No contacts yet',
            body: 'Contacts arrive from forms, calls and imports — or add one manually.',
          },
    [query],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <label htmlFor="contact-search" className="sr-only">
            Search contacts by name, email or phone
          </label>
          <input
            id="contact-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search contacts…"
            className="h-10 w-full rounded-md border border-line bg-surface-2 px-3.5 text-body text-text transition-colors duration-[120ms] placeholder:text-text-subtle hover:border-line-strong focus-visible:outline-none"
          />
        </div>
        {canCreate ? (
          <Button size="md" onClick={() => setDialogOpen(true)}>
            Add contact
          </Button>
        ) : null}
      </div>

      {/* Result count announced politely so a screen reader learns the search
          outcome without the table being re-read on every keystroke. */}
      <p aria-live="polite" className="sr-only">
        {loading ? 'Loading contacts' : `${items.length} contacts shown`}
      </p>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-critical/40 bg-critical-dim/20 px-3.5 py-2.5 text-body text-critical"
        >
          {error}
        </p>
      ) : null}

      <Surface level={1} className="overflow-hidden p-0">
        {/* Wide content scrolls inside its own container — the page body never
            scrolls sideways. */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <caption className="sr-only">Contacts in this workspace</caption>
            <thead>
              <tr className="border-b border-line text-left">
                <Th>Name</Th>
                <Th>Source</Th>
                <Th>Company</Th>
                <Th>Owner</Th>
                <Th className="text-right">Open deals</Th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0
                ? Array.from({ length: 5 }, (_, index) => (
                    <tr key={`skeleton-${index}`} className="border-b border-line last:border-0">
                      <td colSpan={5} className="px-4 py-3">
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))
                : items.map((contact) => (
                    <tr
                      key={contact.id}
                      className="border-b border-line transition-colors duration-[120ms] last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-4 py-2.5">
                        {/* The whole name is the link target — a row-level
                            onClick would be invisible to keyboard users. */}
                        <Link
                          href={`/customers/contacts/${contact.id}`}
                          className="font-medium text-text hover:text-signal focus-visible:outline-none"
                        >
                          {contact.displayName}
                        </Link>
                        <span className="block text-caption text-text-subtle">
                          {contact.email ?? contact.phone ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <SourceBadge source={contact.firstSource} />
                      </td>
                      <td className="px-4 py-2.5 text-text-muted">{contact.companyName ?? '—'}</td>
                      <td className="px-4 py-2.5 text-text-muted">{contact.ownerName ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        {contact.openOpportunityCount > 0 ? (
                          <Badge tone="signal">{contact.openOpportunityCount}</Badge>
                        ) : (
                          <span className="text-text-subtle">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>

        {isEmpty ? (
          <div className="px-6 py-14 text-center">
            <p className="text-h3 text-text">{emptyMessage.title}</p>
            <p className="mt-1.5 text-body text-text-muted">{emptyMessage.body}</p>
            {canCreate && !query ? (
              <Button className="mt-5" onClick={() => setDialogOpen(true)}>
                Add your first contact
              </Button>
            ) : null}
          </div>
        ) : null}
      </Surface>

      {page.nextCursor ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={loading}
            loadingLabel="Loading more contacts"
            onClick={() => void fetchContacts(query, page.nextCursor ?? undefined)}
          >
            Load more
          </Button>
        </div>
      ) : null}

      {dialogOpen ? (
        <CreateContactDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(contact) => {
            setDialogOpen(false);
            // Prepend rather than refetch: the operator sees their new contact
            // immediately, and the server already returned the authoritative row.
            startTransition(() => setItems((existing) => [contact, ...existing]));
          }}
        />
      ) : null}
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 text-overline font-semibold text-text-subtle uppercase ${className}`}
    >
      {children}
    </th>
  );
}
