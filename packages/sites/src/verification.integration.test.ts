/**
 * Verification against a real database — issuing, rotation, and state.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * Rotation's guarantees are the database's: the CHECK constraint that a
 * `verified` row must carry `verified_at` and a method, and the fact that
 * re-issuing a token does NOT clear a verification. A mock would assert that the
 * code calls Drizzle.
 *
 * Every assertion runs as the RESTRICTED, NON-OWNER role.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import type { CrmDomainEvent, TenantActor, WorkspaceRole } from '@growth-os/contracts';
import { FixtureResolver, FixtureTransport } from '@growth-os/net/testing';
import { issueVerificationToken, verifySite, type VerificationDependencies } from './verification';
import { createSite } from './service';
import type { SitesContext } from './context';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;
const { sites, users, workspaces } = schemaTables;

const ORIGIN = 'https://abcplumbing.test';
const PUBLIC_IP = '93.184.216.34';

describeIntegration('site verification', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let userId: string;
  let published: CrmDomainEvent[];

  function contextFor(role: WorkspaceRole): SitesContext {
    const workspace = {
      workspaceId,
      workspaceName: 'ABC Plumbing',
      workspaceSlug: 'abc-plumbing',
      agencyId: null,
      role,
      via: 'direct' as const,
    };
    const tenant: TenantActor = {
      actor: {
        userId,
        email: 'sam@abcplumbing.test',
        name: 'Sam',
        sessionId: 's',
        workspaces: [workspace],
        agencies: [],
      },
      workspace,
    };
    return {
      deps: {
        db: harness.app as unknown as Database,
        events: { publish: (event) => published.push(event) },
      },
      tenant,
      correlationId: null,
    };
  }

  /** A homepage serving whatever markup the test wants. */
  const serving = (body: string): VerificationDependencies => ({
    network: {
      resolver: new FixtureResolver({ 'abcplumbing.test': [PUBLIC_IP] }),
      transport: new FixtureTransport({
        [`${ORIGIN}/`]: { status: 200, headers: { 'content-type': 'text/html' }, body },
      }),
    },
    txt: {
      async resolveTxt() {
        const e = new Error('ENOTFOUND') as NodeJS.ErrnoException;
        e.code = 'ENOTFOUND';
        throw e;
      },
    },
  });

  const page = (token: string) =>
    `<html><head><meta name="growth-os-verification" content="${token}" /></head></html>`;

  beforeAll(async () => {
    harness = await createTestHarness();
    await assertRestrictedRole(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    published = [];
    const [workspace] = await harness.owner
      .insert(workspaces)
      .values({ name: 'ABC Plumbing', slug: 'abc-plumbing' })
      .returning();
    workspaceId = workspace!.id;
    const [user] = await harness.owner
      .insert(users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam', passwordHash: null })
      .returning();
    userId = user!.id;
  });

  async function newSite(): Promise<string> {
    const site = await createSite(contextFor('owner'), { name: 'Main', origin: ORIGIN });
    return site.id;
  }

  describe('issuing a token', () => {
    it('issues a 128-bit token and moves the site to pending', async () => {
      const siteId = await newSite();
      const { instructions } = await issueVerificationToken(contextFor('owner'), siteId);

      expect(instructions.map((i) => i.method)).toEqual(['html_meta', 'dns_txt']);
      const [row] = await harness.owner.select().from(sites).where(eq(sites.id, siteId));
      expect(row?.verificationToken).toMatch(/^[0-9a-f]{32}$/);
      expect(row?.verificationState).toBe('pending');
      expect(row?.verifiedAt).toBeNull();
    });

    it('refuses a member — issuing is administrative', async () => {
      const siteId = await newSite();
      await expect(issueVerificationToken(contextFor('member'), siteId)).rejects.toThrow();
    });
  });

  describe('verifying', () => {
    it('verifies a site whose homepage carries the token, and records how', async () => {
      const siteId = await newSite();
      const { instructions } = await issueVerificationToken(contextFor('owner'), siteId);
      const token = instructions[0]!.token;

      const result = await verifySite(contextFor('owner'), serving(page(token)), siteId);
      expect(result).toEqual({ verified: true, method: 'html_meta' });

      const [row] = await harness.owner.select().from(sites).where(eq(sites.id, siteId));
      expect(row?.verificationState).toBe('verified');
      // The CHECK constraint requires both; a verified row that cannot be
      // audited is not representable.
      expect(row?.verifiedAt).not.toBeNull();
      expect(row?.verificationMethod).toBe('html_meta');
    });

    it('publishes seo.site.verified exactly once', async () => {
      const siteId = await newSite();
      const { instructions } = await issueVerificationToken(contextFor('owner'), siteId);
      await verifySite(contextFor('owner'), serving(page(instructions[0]!.token)), siteId);

      const events = published.filter((e) => e.name === 'seo.site.verified');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ siteId, method: 'html_meta' });
    });

    it('leaves the site unverified when the token is absent, and records the attempt', async () => {
      const siteId = await newSite();
      await issueVerificationToken(contextFor('owner'), siteId);

      const result = await verifySite(
        contextFor('owner'),
        serving('<html><head></head></html>'),
        siteId,
      );
      expect(result.verified).toBe(false);

      const [row] = await harness.owner.select().from(sites).where(eq(sites.id, siteId));
      expect(row?.verificationState).toBe('pending');
      // The attempt is recorded even though it failed — "we looked and did not
      // find it" is a different fact from "we never looked".
      expect(row?.verificationCheckedAt).not.toBeNull();
    });

    it('refuses to verify a site with no token issued', async () => {
      const siteId = await newSite();
      await expect(
        verifySite(contextFor('owner'), serving(page('0'.repeat(32))), siteId),
      ).rejects.toThrow();
    });

    it('refuses a member — verifying unlocks crawling', async () => {
      const siteId = await newSite();
      await issueVerificationToken(contextFor('owner'), siteId);
      await expect(
        verifySite(contextFor('member'), serving('<html></html>'), siteId),
      ).rejects.toThrow();
    });
  });

  describe('⚠️ rotation', () => {
    it('the OLD published token stops working', async () => {
      const siteId = await newSite();
      const first = (await issueVerificationToken(contextFor('owner'), siteId)).instructions[0]!
        .token;
      const second = (await issueVerificationToken(contextFor('owner'), siteId)).instructions[0]!
        .token;

      expect(second).not.toBe(first);

      // A customer who sold a site cannot have it re-verified by whoever bought
      // it using the string still sitting in the old page source.
      const stale = await verifySite(contextFor('owner'), serving(page(first)), siteId);
      expect(stale).toEqual({ verified: false, failure: 'token_mismatch' });

      const current = await verifySite(contextFor('owner'), serving(page(second)), siteId);
      expect(current.verified).toBe(true);
    });

    it('a VERIFIED site stays verified while its owner rotates the proof', async () => {
      const siteId = await newSite();
      const first = (await issueVerificationToken(contextFor('owner'), siteId)).instructions[0]!
        .token;
      await verifySite(contextFor('owner'), serving(page(first)), siteId);

      const before = await harness.owner.select().from(sites).where(eq(sites.id, siteId));
      expect(before[0]?.verificationState).toBe('verified');

      await issueVerificationToken(contextFor('owner'), siteId);

      const after = await harness.owner.select().from(sites).where(eq(sites.id, siteId));
      // A business that rotates its proof has not stopped owning its domain.
      expect(after[0]?.verificationState).toBe('verified');
      expect(after[0]?.verifiedAt).not.toBeNull();
      expect(after[0]?.verificationToken).not.toBe(first);
    });
  });

  describe('tenant isolation', () => {
    it("cannot issue a token for another workspace's site", async () => {
      const siteId = await newSite();

      const [other] = await harness.owner
        .insert(workspaces)
        .values({ name: 'Meridian', slug: 'meridian' })
        .returning();
      const otherContext = { ...contextFor('owner') };
      // Same actor object, a different workspace — the shape an IDOR takes.
      const crossTenant: SitesContext = {
        ...otherContext,
        tenant: {
          ...otherContext.tenant,
          workspace: { ...otherContext.tenant.workspace, workspaceId: other!.id },
        },
      };

      // Not found rather than forbidden: distinguishing them would confirm the
      // row exists to anyone who can guess a UUID.
      await expect(issueVerificationToken(crossTenant, siteId)).rejects.toThrow(/not found/i);
    });
  });
});
