import { Surface } from '@growth-os/ui';

/**
 * Shown when an authenticated user has no accessible workspace.
 *
 * A real state — a newly invited agency member with no clients yet — so it is
 * handled rather than allowed to crash on a null workspace.
 */
export function WorkspaceRequired() {
  return (
    <Surface level={1} className="mx-auto max-w-lg p-8 text-center">
      <h1 className="text-h2 text-text">No workspace yet</h1>
      <p className="mt-2 text-body text-text-muted">
        Your account is not a member of any workspace. Ask an administrator to add you.
      </p>
    </Surface>
  );
}
