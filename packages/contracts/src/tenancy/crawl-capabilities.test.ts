/**
 * The crawl capability matrix.
 *
 * WHY THIS FILE EXISTS NOW
 * `workspace:crawls:read`, `:run` and `:manage` have been declared since Stage
 * 4 opened and, until the crawl is wired to an operator, had **no enforcement
 * call site and no grant test** — measured in dev log 0035. §5 requires a grant
 * test proving each role gets what it should and nothing more, and the first
 * session to enforce a capability is the session that owes it.
 *
 * Negative-first, matching `crm/capabilities.test.ts`: the assertions that
 * matter are the ones proving a role does NOT hold a capability.
 *
 * ⚠️ NONE OF THIS IS PERMISSION TO CRAWL AN ADDRESS. A role grants the right to
 * ASK for a crawl; the site must separately be `verified`, which is a proof and
 * cannot be granted by a role (ADR-0031). The two gates are independent and
 * both are tested — the role gate here, the verification gate in
 * `packages/sites/src/crawls.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_ROLES,
  workspaceRoleHasCapability,
  type Capability,
  type WorkspaceRole,
} from './capabilities';

const READ: Capability = 'workspace:crawls:read';
const RUN: Capability = 'workspace:crawls:run';
const MANAGE: Capability = 'workspace:crawls:manage';

describe('viewer', () => {
  it('CAN read crawl results', () => {
    expect(workspaceRoleHasCapability('viewer', READ)).toBe(true);
  });

  it.each([RUN, MANAGE])('CANNOT %s', (capability) => {
    // Starting a crawl is an outbound request at volume against somebody
    // else's server. Reading what one found is not.
    expect(workspaceRoleHasCapability('viewer', capability)).toBe(false);
  });
});

describe('member — the day-to-day operator', () => {
  it.each([READ, RUN])('CAN %s', (capability) => {
    // "I fixed the missing titles — recrawl and show me" is daily
    // investigative work, and an operator who must ask an admin stops checking.
    expect(workspaceRoleHasCapability('member', capability)).toBe(true);
  });

  it('CANNOT manage crawl configuration', () => {
    // Concurrency and delay decide how hard someone else's server is asked to
    // work. Running a crawl within the configured budget is daily; changing
    // the budget is not.
    expect(workspaceRoleHasCapability('member', MANAGE)).toBe(false);
  });
});

describe('admin and owner', () => {
  it.each(['admin', 'owner'] as const)('%s CAN manage crawl configuration', (role) => {
    expect(workspaceRoleHasCapability(role, MANAGE)).toBe(true);
  });
});

describe('privilege ordering holds across the crawl capabilities', () => {
  it('each role is a superset of the one below it', () => {
    const held = (role: WorkspaceRole): Set<Capability> =>
      new Set([READ, RUN, MANAGE].filter((c) => workspaceRoleHasCapability(role, c)));

    for (let i = 1; i < WORKSPACE_ROLES.length; i += 1) {
      const lower = held(WORKSPACE_ROLES[i - 1]!);
      const higher = held(WORKSPACE_ROLES[i]!);
      for (const capability of lower) {
        expect(
          higher.has(capability),
          `${WORKSPACE_ROLES[i]} lost ${capability} that ${WORKSPACE_ROLES[i - 1]} holds`,
        ).toBe(true);
      }
    }
  });

  it('no role below member can start a crawl', () => {
    // The one assertion that would catch a well-meaning widening of the matrix.
    expect(workspaceRoleHasCapability('viewer', RUN)).toBe(false);
  });
});
