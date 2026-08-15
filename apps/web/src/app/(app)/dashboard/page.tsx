/**
 * Dashboard home.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The operator's landing surface. It answers ONE question first — *what should
 * I do next?* — and everything else supports that (Principle 7).
 *
 * ⚠️  ALL METRICS ARE DEVELOPMENT FIXTURES. No data source is connected.
 * The snapshot is marked `provenance: 'fixture'`, which drives a
 * non-dismissible banner and a Demo badge on every value. See
 * `lib/fixtures/growth-demo.ts`.
 *
 * WHY THE SHAPE IS ALREADY THE PRODUCTION SHAPE
 * `GrowthSnapshot` is the contract the real ingestion pipeline will satisfy.
 * When Stages 3–15 land, the fixture call below becomes a query and nothing
 * else on this page changes.
 *
 * @see docs/product/product-principles.md (Principles 3 and 7)
 */

import type { Metadata } from 'next';
import { Surface } from '@growth-os/ui';
import { requireAuthContext } from '../../../server/auth-context';
import { buildFixtureSnapshot } from '../../../lib/fixtures/growth-demo';
import { EntranceStep } from '../../../components/shell/app-shell';
import { HeadlineMetric, MetricCard } from '../../../components/dashboard/metric-card';
import { OpportunityList } from '../../../components/dashboard/opportunity-list';
import { AskGrowthAi } from '../../../components/dashboard/ask-growth-ai';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const { workspace } = await requireAuthContext('/dashboard');

  // A user can legitimately have no workspaces — a newly invited agency member
  // with no clients yet. Handled rather than assumed away.
  if (!workspace) {
    return (
      <Surface level={1} className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-h2 text-text">No workspace yet</h1>
        <p className="mt-2 text-body text-text-muted">
          Your account is not a member of any workspace. Ask an administrator to add you, or create
          one once workspace provisioning ships in Stage 2.
        </p>
      </Surface>
    );
  }

  // Generated server-side and passed down, so server and client renders agree.
  const snapshot = buildFixtureSnapshot(
    workspace.workspaceId,
    workspace.workspaceName,
    new Date().toISOString(),
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <EntranceStep id="hero">
        <div className="flex flex-col gap-5">
          {/*
            Non-dismissible demo banner. Driven by `snapshot.provenance`, so it
            disappears automatically once real sources are connected — it
            cannot be forgotten in place, and it cannot be turned off while the
            data is still fictional.
          */}
          {snapshot.provenance === 'fixture' ? (
            <div
              role="note"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-attention/40 bg-attention-dim/15 px-4 py-2.5 text-caption"
            >
              <span className="font-semibold text-attention uppercase">Demo data</span>
              <span className="text-text-muted">
                Every figure on this page is a development fixture. No SEO, CRM, call or revenue
                source is connected yet.
              </span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-h1 tracking-tight text-text">{snapshot.workspaceName}</h1>
              <p className="mt-1 text-body text-text-muted">
                {snapshot.periodLabel}
                {workspace.via === 'agency' ? ' · accessed via your agency' : ''}
              </p>
            </div>
          </div>

          <HeadlineMetric metric={snapshot.headline} />
        </div>
      </EntranceStep>

      <EntranceStep id="cards">
        <section aria-labelledby="metrics-heading" className="flex flex-col gap-3">
          <h2 id="metrics-heading" className="text-overline text-text-subtle uppercase">
            This period
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {snapshot.metrics.map((metric) => (
              <MetricCard key={metric.key} metric={metric} />
            ))}
          </div>
        </section>
      </EntranceStep>

      <EntranceStep id="cards" index={1}>
        <section aria-labelledby="opportunities-heading" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="opportunities-heading" className="text-overline text-text-subtle uppercase">
              Growth opportunities
            </h2>
            <span className="text-caption text-text-subtle">Ranked by expected revenue</span>
          </div>
          <OpportunityList opportunities={snapshot.opportunities} />
        </section>
      </EntranceStep>

      <EntranceStep id="ai">
        <AskGrowthAi workspaceId={workspace.workspaceId} />
      </EntranceStep>
    </div>
  );
}
