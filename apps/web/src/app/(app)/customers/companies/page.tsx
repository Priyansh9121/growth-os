/**
 * Companies — the organisations contacts belong to.
 *
 * A READ SURFACE, deliberately. Companies are created as a side effect of
 * ingestion and import (a "Company" column, a form field), so the pressing need
 * was somewhere to SEE them — including the ones automation has been quietly
 * creating. A create-and-edit UI is a separate piece of work and is not
 * pretended at here.
 *
 * The contact count is what makes the page useful: it is how an operator spots
 * "ABC Plumbing" and "ABC Plumbing Pty Ltd" existing as two records.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { listCompanies } from '@growth-os/crm';
import { Surface } from '@growth-os/ui';
import { requireAuthContext } from '../../../../server/auth-context';
import { buildServerCrmContext } from '../../../../server/crm-server';
import { WorkspaceRequired } from '../../../../components/crm/workspace-required';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Companies',
  description: 'Organisations that contacts belong to.',
};

type SearchParams = { searchParams: Promise<{ q?: string; cursor?: string }> };

export default async function CompaniesPage({ searchParams }: SearchParams) {
  const { actor, workspace } = await requireAuthContext('/customers/companies');
  if (!workspace) return <WorkspaceRequired />;

  const { q, cursor } = await searchParams;
  const crm = buildServerCrmContext(actor, workspace);

  const page = await listCompanies(crm, {
    // Same closed-filter discipline as every other list: a named query
    // parameter, never a generic expression a client could compose
    // (ADR-0016 §2).
    query: q,
    cursor,
    limit: 50,
  });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1 tracking-tight text-text">Companies</h1>
          <p className="mt-1 text-body text-text-muted">Organisations your contacts belong to.</p>
        </div>

        <form method="get" className="flex items-center gap-2">
          <label htmlFor="company-search" className="sr-only">
            Search companies
          </label>
          <input
            id="company-search"
            name="q"
            type="search"
            defaultValue={q ?? ''}
            placeholder="Search by name"
            className="h-9 w-56 rounded-sm border border-line bg-surface-2 px-2.5 text-body text-text transition-colors duration-[120ms] hover:border-line-strong focus-visible:outline-none"
          />
        </form>
      </header>

      {page.items.length === 0 ? (
        <Surface level={1} className="p-8 text-center">
          <p className="text-body text-text-muted">
            {q ? `No company matches “${q}”.` : 'No companies yet.'}
          </p>
          <p className="mt-2 text-caption text-text-subtle">
            Companies are created automatically when a contact arrives with a business name — from a
            form, an import, or a call.
          </p>
        </Surface>
      ) : (
        <Surface level={1} className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] border-collapse">
            <caption className="sr-only">
              Companies in this workspace, newest first, with the number of contacts at each.
            </caption>
            <thead>
              <tr className="border-b border-line">
                <Th>Company</Th>
                <Th>Website</Th>
                <Th>Phone</Th>
                <Th align="right">Contacts</Th>
                <Th align="right">Added</Th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((company) => (
                <tr key={company.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-3 text-body text-text">{company.name}</td>
                  <td className="px-5 py-3 text-body text-text-muted">
                    {company.website ? (
                      <a
                        href={`https://${company.website}`}
                        // A customer-supplied host. `noopener` stops the opened
                        // page reaching back through `window.opener`, and
                        // `nofollow` keeps a CRM record from becoming an
                        // outbound link we vouch for.
                        rel="noopener noreferrer nofollow"
                        target="_blank"
                        className="hover:text-signal"
                      >
                        {company.website}
                      </a>
                    ) : (
                      <span className="text-text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-body text-text-muted">
                    {company.phone ?? <span className="text-text-subtle">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-body text-text tabular-nums">
                    {company.contactCount}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-caption text-text-subtle tabular-nums">
                    {new Date(company.createdAt).toLocaleDateString('en-AU')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Surface>
      )}

      {page.nextCursor ? (
        <div>
          <Link
            href={`/customers/companies?${new URLSearchParams({
              ...(q ? { q } : {}),
              cursor: page.nextCursor,
            }).toString()}`}
            className="inline-flex h-9 items-center rounded-md border border-line px-3.5 text-body text-text-muted transition-colors duration-[120ms] hover:border-line-strong hover:text-text focus-visible:outline-none"
          >
            Next page
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`px-5 py-2.5 text-overline text-text-subtle uppercase ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
