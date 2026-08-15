/**
 * Tenant isolation — application layer.
 *
 * WHY THESE ARE MOSTLY NEGATIVE TESTS
 * A passing happy path proves nothing about isolation. "User A can read
 * workspace A" would still pass if the guard returned true unconditionally.
 * The tests that matter are the ones asserting access is DENIED, so most of
 * this file is about what must not be possible.
 *
 * @see docs/security/tenant-isolation.md
 * @see docs/product/user-journeys.md §J7
 */

import { describe, expect, it } from 'vitest';
import { AuthorizationError, type Actor } from '@growth-os/contracts';
import {
  canAccessWorkspace,
  canInWorkspace,
  requireAgencyAccess,
  requireWorkspaceAccess,
  resolveActiveWorkspace,
} from './guards';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const AGENCY_A = '33333333-3333-4333-8333-333333333333';

function makeActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1',
    email: 'sam@abcplumbing.test',
    name: 'Sam Whitfield',
    sessionId: 'session-1',
    workspaces: [
      {
        workspaceId: WORKSPACE_A,
        workspaceName: 'ABC Plumbing',
        workspaceSlug: 'abc-plumbing',
        agencyId: null,
        role: 'owner',
        via: 'direct',
      },
    ],
    agencies: [],
    ...overrides,
  };
}

describe('requireWorkspaceAccess', () => {
  it('returns a bound TenantActor for a workspace the actor belongs to', () => {
    const actor = makeActor();
    const tenant = requireWorkspaceAccess(actor, WORKSPACE_A);

    expect(tenant.workspace.workspaceId).toBe(WORKSPACE_A);
    expect(tenant.actor.userId).toBe('user-1');
  });

  it('DENIES a workspace the actor has no membership in', () => {
    const actor = makeActor();
    expect(() => requireWorkspaceAccess(actor, WORKSPACE_B)).toThrow(AuthorizationError);
  });

  it('denies a nonexistent workspace with the SAME error as an unauthorized one', () => {
    // Distinguishing "not found" from "forbidden" across a tenant boundary
    // would confirm the existence of another tenant's workspace to anyone who
    // can guess an ID. Both paths must be indistinguishable to the caller.
    const actor = makeActor();

    let unauthorizedMessage = '';
    let missingMessage = '';

    try {
      requireWorkspaceAccess(actor, WORKSPACE_B);
    } catch (error) {
      unauthorizedMessage = (error as AuthorizationError).publicMessage;
    }
    try {
      requireWorkspaceAccess(actor, '99999999-9999-4999-8999-999999999999');
    } catch (error) {
      missingMessage = (error as AuthorizationError).publicMessage;
    }

    expect(unauthorizedMessage).toBe(missingMessage);
    expect(unauthorizedMessage).not.toContain(WORKSPACE_B);
  });

  it('denies when the role lacks the required capability', () => {
    const actor = makeActor({
      workspaces: [
        {
          workspaceId: WORKSPACE_A,
          workspaceName: 'ABC Plumbing',
          workspaceSlug: 'abc-plumbing',
          agencyId: null,
          role: 'viewer',
          via: 'direct',
        },
      ],
    });

    // A viewer may read...
    expect(() => requireWorkspaceAccess(actor, WORKSPACE_A, 'workspace:read')).not.toThrow();
    // ...but must not be able to write, export, or manage members.
    expect(() => requireWorkspaceAccess(actor, WORKSPACE_A, 'workspace:data:write')).toThrow(
      AuthorizationError,
    );
    expect(() => requireWorkspaceAccess(actor, WORKSPACE_A, 'workspace:export')).toThrow(
      AuthorizationError,
    );
    expect(() => requireWorkspaceAccess(actor, WORKSPACE_A, 'workspace:members:invite')).toThrow(
      AuthorizationError,
    );
  });

  it('never exposes internal detail in the public message', () => {
    const actor = makeActor();
    try {
      requireWorkspaceAccess(actor, WORKSPACE_B, 'workspace:delete');
      expect.unreachable('should have thrown');
    } catch (error) {
      const authError = error as AuthorizationError;
      // The internal message carries specifics for the log...
      expect(authError.message).toContain(WORKSPACE_B);
      // ...but the public one never does.
      expect(authError.publicMessage).not.toContain(WORKSPACE_B);
      expect(authError.publicMessage).not.toContain('user-1');
      expect(authError.httpStatus).toBe(403);
    }
  });
});

describe('agency-derived access', () => {
  const agencyActor = makeActor({
    userId: 'user-agency',
    email: 'riley@northbeam.test',
    workspaces: [
      {
        workspaceId: WORKSPACE_B,
        workspaceName: 'Harbour Dental',
        workspaceSlug: 'harbour-dental',
        agencyId: AGENCY_A,
        role: 'admin',
        via: 'agency',
      },
    ],
    agencies: [
      {
        agencyId: AGENCY_A,
        agencyName: 'Northbeam',
        agencySlug: 'northbeam',
        role: 'agency_admin',
      },
    ],
  });

  it('grants workspace access reached only through an agency', () => {
    const tenant = requireWorkspaceAccess(agencyActor, WORKSPACE_B, 'workspace:data:write');
    // `via` must survive to the audit trail so an agency's action is
    // distinguishable from the client's own.
    expect(tenant.workspace.via).toBe('agency');
  });

  it('does NOT grant agency-derived workspaces that belong to another agency', () => {
    expect(() => requireWorkspaceAccess(agencyActor, WORKSPACE_A)).toThrow(AuthorizationError);
  });

  it('denies agency capabilities the agency role does not hold', () => {
    // agency_admin manages client workspaces but must not manage agency
    // membership or billing.
    expect(() =>
      requireAgencyAccess(agencyActor, AGENCY_A, 'agency:workspaces:create'),
    ).not.toThrow();
    expect(() => requireAgencyAccess(agencyActor, AGENCY_A, 'agency:members:manage')).toThrow(
      AuthorizationError,
    );
    expect(() => requireAgencyAccess(agencyActor, AGENCY_A, 'agency:billing:manage')).toThrow(
      AuthorizationError,
    );
  });
});

describe('resolveActiveWorkspace', () => {
  it('treats the cookie as a HINT and ignores an unauthorized value', () => {
    // The central property: a user who edits the workspace cookie to another
    // tenant's ID gains nothing. It silently falls back to their own default.
    const actor = makeActor();
    const resolved = resolveActiveWorkspace(actor, null, WORKSPACE_B);

    expect(resolved?.workspaceId).toBe(WORKSPACE_A);
  });

  it('honours a valid cookie hint', () => {
    const actor = makeActor({
      workspaces: [
        {
          workspaceId: WORKSPACE_A,
          workspaceName: 'A',
          workspaceSlug: 'a',
          agencyId: null,
          role: 'owner',
          via: 'direct',
        },
        {
          workspaceId: WORKSPACE_B,
          workspaceName: 'B',
          workspaceSlug: 'b',
          agencyId: null,
          role: 'member',
          via: 'direct',
        },
      ],
    });

    expect(resolveActiveWorkspace(actor, null, WORKSPACE_B)?.workspaceId).toBe(WORKSPACE_B);
  });

  it('THROWS on an explicit unauthorized request rather than falling back', () => {
    // A silent fallback here would serve the caller a different workspace's
    // data than they asked for, without either side noticing.
    const actor = makeActor();
    expect(() => resolveActiveWorkspace(actor, WORKSPACE_B, null)).toThrow(AuthorizationError);
  });

  it('returns null when the actor has no workspaces', () => {
    // A real state for a newly invited agency user. Must not throw.
    expect(resolveActiveWorkspace(makeActor({ workspaces: [] }), null, null)).toBeNull();
  });
});

describe('capability predicates', () => {
  it('canAccessWorkspace mirrors requireWorkspaceAccess', () => {
    const actor = makeActor();
    expect(canAccessWorkspace(actor, WORKSPACE_A)).toBe(true);
    expect(canAccessWorkspace(actor, WORKSPACE_B)).toBe(false);
  });

  it('canInWorkspace returns false for an unknown workspace rather than throwing', () => {
    // UI predicates must be total: a throw during render would take out the
    // page instead of hiding a button.
    expect(canInWorkspace(makeActor(), WORKSPACE_B, 'workspace:read')).toBe(false);
  });
});
