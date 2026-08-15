/**
 * Placeholder for declared-but-unbuilt modules.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * A single catch-all that resolves any navigation destination from the
 * manifest in `lib/navigation.ts`. One file serves ~20 routes, so:
 *
 *  - every sidebar link works; there are no dead links and no 404s
 *  - no empty route files exist purely to satisfy a menu
 *  - the manifest cannot drift from the routes, because it IS the routes
 *
 * Next.js resolves specific segments before a catch-all, so real routes such
 * as `/dashboard` are unaffected by this file.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not render a convincing empty screen with fake charts. It states
 * what the module will do, which roadmap stage delivers it, and what it
 * depends on. An unbuilt surface must not look finished (Principle 3).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Badge, Surface } from '@growth-os/ui';
import { GROWTH_LOOP_STAGE_LABELS } from '@growth-os/contracts';
import { findNavItemByPath, STATUS_LABEL } from '../../../lib/navigation';

interface PageProps {
  readonly params: Promise<{ module: string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { module } = await params;
  const item = findNavItemByPath(module);
  return { title: item?.label ?? 'Not found' };
}

export default async function ModulePlaceholderPage({ params }: PageProps) {
  const { module } = await params;
  const item = findNavItemByPath(module);

  // A path not in the manifest is a genuine 404. The catch-all must not become
  // a wildcard that renders something friendly for every typo — that hides
  // broken links rather than surfacing them.
  if (!item) notFound();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 pt-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-h1 tracking-tight text-text">{item.label}</h1>
        <Badge tone={item.status === 'partial' ? 'signal' : 'neutral'}>
          {STATUS_LABEL[item.status]}
        </Badge>
        {item.loopStage ? (
          <Badge tone="neutral">{GROWTH_LOOP_STAGE_LABELS[item.loopStage]}</Badge>
        ) : null}
      </div>

      {item.description ? <p className="text-body-lg text-text-muted">{item.description}</p> : null}

      <Surface level={1} className="flex flex-col gap-4 p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2">
            <span className="font-mono text-caption text-text-subtle tabular-nums">
              {item.stage}
            </span>
          </div>
          <div>
            <h2 className="text-h3 text-text">Planned for Stage {item.stage}</h2>
            <p className="mt-1.5 text-body text-text-muted">
              This module is designed but not built. Growth OS is at Stage 1 — foundation,
              authentication, the design system and the application shell.
            </p>
            <p className="mt-3 text-caption text-text-subtle">
              The full sequence, with each stage&rsquo;s deliverables, dependencies, risks and
              definition of done, is in{' '}
              <code className="font-mono text-text-muted">docs/product/product-roadmap.md</code>.
            </p>
          </div>
        </div>
      </Surface>

      <p className="text-caption text-text-subtle">
        Nothing on this screen is simulated. When this module ships, this placeholder is replaced by
        the real surface.
      </p>
    </div>
  );
}
