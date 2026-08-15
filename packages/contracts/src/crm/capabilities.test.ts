/**
 * CRM capability matrix.
 *
 * Negative-first: the assertions that matter are the ones proving a role does
 * NOT hold a capability. A matrix that granted everything would pass every
 * positive test.
 *
 * @see docs/decisions/ADR-0005-multi-tenancy-model.md
 */

import { describe, expect, it } from 'vitest';
import {
  workspaceRoleHasCapability,
  type Capability,
  type WorkspaceRole,
} from '../tenancy/capabilities';

const CRM_READS: Capability[] = [
  'workspace:crm:contacts:read',
  'workspace:crm:companies:read',
  'workspace:crm:opportunities:read',
  'workspace:crm:tasks:read',
  'workspace:crm:activities:read',
];

const CRM_WRITES: Capability[] = [
  'workspace:crm:contacts:write',
  'workspace:crm:companies:write',
  'workspace:crm:opportunities:write',
  'workspace:crm:tasks:write',
];

const CRM_ADMIN: Capability[] = [
  'workspace:crm:contacts:archive',
  'workspace:crm:pipelines:manage',
];

describe('viewer', () => {
  it.each(CRM_READS)('CAN %s', (capability) => {
    expect(workspaceRoleHasCapability('viewer', capability)).toBe(true);
  });

  it.each([...CRM_WRITES, ...CRM_ADMIN])('CANNOT %s', (capability) => {
    expect(workspaceRoleHasCapability('viewer', capability)).toBe(false);
  });
});

describe('member — the day-to-day operator', () => {
  it.each([...CRM_READS, ...CRM_WRITES])('CAN %s', (capability) => {
    expect(workspaceRoleHasCapability('member', capability)).toBe(true);
  });

  it.each(CRM_ADMIN)('CANNOT %s — administrative, not daily', (capability) => {
    // Removing a customer record and reshaping the sales process are
    // administrative acts. A member doing their job should not be able to
    // archive a contact or restructure the pipeline.
    expect(workspaceRoleHasCapability('member', capability)).toBe(false);
  });
});

describe('admin', () => {
  it.each([...CRM_READS, ...CRM_WRITES, ...CRM_ADMIN])('CAN %s', (capability) => {
    expect(workspaceRoleHasCapability('admin', capability)).toBe(true);
  });

  it('still CANNOT delete the workspace or manage billing', () => {
    expect(workspaceRoleHasCapability('admin', 'workspace:delete')).toBe(false);
    expect(workspaceRoleHasCapability('admin', 'workspace:billing:manage')).toBe(false);
  });
});

describe('owner', () => {
  it.each([...CRM_READS, ...CRM_WRITES, ...CRM_ADMIN])('CAN %s', (capability) => {
    expect(workspaceRoleHasCapability('owner', capability)).toBe(true);
  });
});

describe('capability lookups are total', () => {
  it('returns false rather than throwing for an unknown role', () => {
    // Authorization helpers must never throw: a throw in an error path can be
    // caught and handled into an allow.
    expect(
      workspaceRoleHasCapability('nonsense' as WorkspaceRole, 'workspace:crm:contacts:read'),
    ).toBe(false);
  });

  it('returns false for an unknown capability', () => {
    expect(workspaceRoleHasCapability('owner', 'workspace:crm:nothing:read' as Capability)).toBe(
      false,
    );
  });
});

describe('privilege ordering holds across CRM capabilities', () => {
  it('each role is a superset of the one below it', () => {
    const ordered: WorkspaceRole[] = ['viewer', 'member', 'admin', 'owner'];
    const all = [...CRM_READS, ...CRM_WRITES, ...CRM_ADMIN];

    for (let index = 1; index < ordered.length; index += 1) {
      const lower = ordered[index - 1]!;
      const higher = ordered[index]!;
      for (const capability of all) {
        if (workspaceRoleHasCapability(lower, capability)) {
          expect(
            workspaceRoleHasCapability(higher, capability),
            `${higher} must inherit ${capability} from ${lower}`,
          ).toBe(true);
        }
      }
    }
  });
});
