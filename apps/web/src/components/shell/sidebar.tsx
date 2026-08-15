'use client';

/**
 * Primary navigation.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Renders the navigation manifest. Every destination is reachable — unbuilt
 * modules resolve to an honest placeholder via the catch-all route rather than
 * a 404 or a disabled link.
 *
 * WHY UNBUILT MODULES ARE SHOWN AT ALL
 * The navigation is the product architecture made visible. Each planned item
 * carries a visible stage marker, so a user can see the shape of the system
 * without anything pretending to be finished (Principle 3).
 *
 * @see apps/web/src/lib/navigation.ts
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { GrowthMark } from '@growth-os/ui';
import { NAVIGATION, type NavItem } from '../../lib/navigation';

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile trigger. 44px minimum touch target. */}
      <button
        type="button"
        onClick={() => setMobileOpen((open) => !open)}
        aria-expanded={mobileOpen}
        aria-controls="primary-navigation"
        className="fixed top-3 left-3 z-50 grid h-11 w-11 place-items-center rounded-md border border-line bg-surface-1 text-text-muted lg:hidden"
      >
        <span className="sr-only">{mobileOpen ? 'Close navigation' : 'Open navigation'}</span>
        <MenuIcon open={mobileOpen} />
      </button>

      {mobileOpen ? (
        <div
          className="fixed inset-0 z-40 bg-canvas/70 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <nav
        id="primary-navigation"
        aria-label="Primary"
        className={[
          'fixed inset-y-0 left-0 z-40 flex w-[248px] shrink-0 flex-col',
          'border-r border-line bg-surface-1',
          'transition-transform duration-[260ms] ease-standard',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // Always visible from lg up; the transform only governs mobile.
          'lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
        ].join(' ')}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-5">
          <GrowthMark size={20} className="text-signal" />
          <span className="text-body font-semibold tracking-tight">Growth OS</span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {NAVIGATION.map((group) => (
            <div key={group.id} className="mb-5 last:mb-0">
              {group.label ? (
                <h2 className="px-2 pb-2 text-overline text-text-subtle uppercase">
                  {group.label}
                </h2>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <NavLink
                      item={item}
                      active={pathname === item.href}
                      onNavigate={() => setMobileOpen(false)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-line px-5 py-3">
          <p className="text-caption text-text-subtle">Stage 1 · Foundation</p>
        </div>
      </nav>
    </>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      // aria-current is how a screen reader announces "you are here". A colour
      // change alone conveys nothing to assistive technology.
      aria-current={active ? 'page' : undefined}
      className={[
        'group flex items-center justify-between rounded-md px-2.5 py-1.5',
        'text-body transition-colors duration-[120ms] ease-standard',
        'focus-visible:outline-none',
        active
          ? 'bg-surface-2 font-medium text-text'
          : 'text-text-muted hover:bg-surface-2 hover:text-text',
      ].join(' ')}
    >
      <span className="flex min-w-0 items-center gap-2">
        {/* Active indicator, additional to the colour change. */}
        <span
          aria-hidden="true"
          className={[
            'h-3.5 w-0.5 rounded-full transition-colors duration-[120ms]',
            active ? 'bg-signal' : 'bg-transparent',
          ].join(' ')}
        />
        <span className="truncate">{item.label}</span>
      </span>

      {item.status !== 'built' && item.status !== 'partial' ? (
        <span
          className="shrink-0 text-overline text-text-subtle/70 tabular-nums"
          // The visible "S4" is shorthand; assistive tech gets the full phrase.
          aria-label={`Planned for stage ${item.stage}`}
        >
          S{item.stage}
        </span>
      ) : null}
    </Link>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {open ? (
        <path
          d="M6 6 18 18M18 6 6 18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M4 7h16M4 12h16M4 17h16"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
