'use client';

/**
 * Application top bar: workspace switcher and account menu.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Surfaces the tenancy model directly in the interface. The workspace switcher
 * is where the membership graph becomes visible to a user — an agency operator
 * sees several client workspaces here from one identity and one session, with
 * agency-derived access visibly marked.
 *
 * @see docs/architecture/multi-tenancy.md
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@growth-os/ui';
import type { SessionUserView, WorkspaceAccess } from '@growth-os/contracts';

export function TopBar({ user }: { user: SessionUserView }) {
  const active = user.workspaces.find(
    (workspace) => workspace.workspaceId === user.activeWorkspaceId,
  );

  return (
    <header className="gos-glass sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-5 pl-16 lg:px-6 lg:pl-6">
      <WorkspaceSwitcher workspaces={user.workspaces} active={active} />

      <div className="flex items-center gap-2">
        <AskGrowthAiHint />
        <AccountMenu user={user} />
      </div>
    </header>
  );
}

function WorkspaceSwitcher({
  workspaces,
  active,
}: {
  workspaces: readonly WorkspaceAccess[];
  active: WorkspaceAccess | undefined;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useOutsideDismiss(containerRef, () => setOpen(false));

  async function switchTo(workspaceId: string) {
    if (workspaceId === active?.workspaceId) {
      setOpen(false);
      return;
    }

    setSwitching(true);
    try {
      const response = await fetch('/api/auth/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ workspaceId }),
      });

      // A 403 here is the tenancy layer working. It should be unreachable from
      // this menu (we only list authorized workspaces), but the server is the
      // authority and the UI must handle its refusal rather than assume success.
      if (response.ok) {
        setOpen(false);
        // Server Components hold the workspace-scoped data, so a refresh is
        // what actually re-renders the page for the new tenant.
        router.refresh();
      }
    } finally {
      setSwitching(false);
    }
  }

  if (!active) {
    return <span className="text-body text-text-muted">No workspace</span>;
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={switching}
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-body transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:outline-none disabled:opacity-60"
      >
        <span className="font-medium">{active.workspaceName}</span>
        {active.via === 'agency' ? (
          // Agency-derived access is visibly attributed, matching how it is
          // recorded in the audit trail.
          <Badge tone="neutral">Agency</Badge>
        ) : null}
        <ChevronIcon />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Switch workspace"
          className="absolute top-full left-0 z-40 mt-1.5 w-72 rounded-lg border border-line-strong bg-surface-3 p-1.5 shadow-lg"
        >
          {workspaces.map((workspace) => (
            <button
              key={workspace.workspaceId}
              type="button"
              role="menuitem"
              onClick={() => void switchTo(workspace.workspaceId)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-body transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:outline-none"
            >
              <span className="min-w-0">
                <span className="block truncate text-text">{workspace.workspaceName}</span>
                <span className="block text-caption text-text-subtle">
                  {workspace.role}
                  {workspace.via === 'agency' ? ' · via agency' : ''}
                </span>
              </span>
              {workspace.workspaceId === active.workspaceId ? <CheckIcon /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AccountMenu({ user }: { user: SessionUserView }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useOutsideDismiss(containerRef, () => setOpen(false));

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    // Full navigation rather than router.push: it discards all client-side
    // React state, so no fragment of the previous user's data survives on a
    // shared machine.
    window.location.href = '/login';
  }

  const initials = user.name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface-2 text-caption font-medium text-text-muted transition-colors duration-[120ms] hover:border-line-strong hover:text-text focus-visible:outline-none"
      >
        <span className="sr-only">Account menu for {user.name}</span>
        <span aria-hidden="true">{initials}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-40 mt-1.5 w-60 rounded-lg border border-line-strong bg-surface-3 p-1.5 shadow-lg"
        >
          <div className="border-b border-line px-2.5 py-2">
            <p className="truncate text-body text-text">{user.name}</p>
            <p className="truncate text-caption text-text-subtle">{user.email}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="mt-1 w-full rounded-md px-2.5 py-2 text-left text-body text-text-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-text focus-visible:outline-none"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Keyboard-discoverable hint for the future command palette (Stage 2). */
function AskGrowthAiHint() {
  return (
    <span className="hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 text-caption text-text-subtle sm:flex">
      <kbd className="font-mono text-overline">⌘K</kbd>
      <span>Ask Growth AI</span>
    </span>
  );
}

/**
 * Dismiss a popover on outside click or Escape.
 *
 * Escape is not optional: a keyboard user who opens a menu must be able to
 * close it without tabbing through every item.
 */
function useOutsideDismiss(ref: React.RefObject<HTMLElement | null>, onDismiss: () => void) {
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss();
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [ref, onDismiss]);
}

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="text-text-subtle"
    >
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-signal"
    >
      <path
        d="m5 13 4 4L19 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
