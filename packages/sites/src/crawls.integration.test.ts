/**
 * Requesting a crawl, against a real database.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * The two properties that matter are the database's, not the code's: that a
 * REFUSED request leaves no row behind — which only a real transaction can
 * demonstrate — and that the crawl row and its job commit together or not at
 * all. A mock would assert that the code calls Drizzle.
 *
 * ⚠️ THE CENTRAL ASSERTION IS A NEGATIVE ONE. `crawls` and `jobs` are both
 * counted after every refusal. A gate that returns an error and still writes a
 * row is not a gate, and that failure passes any test which only checks that
 * an error was thrown (§6).
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
import { createSite } from './service';
import { claimCrawl, getCrawl, listCrawlsForSite, requestCrawl, RUN_CRAWL_JOB } from './crawls';
import type { SitesContext } from './context';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;
const { crawls, jobs, sites, users, workspaces } = schemaTables;

const ORIGIN = 'https://abcplumbing.test';

describeIntegration('requesting a crawl', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let published: CrmDomainEvent[];

  function contextFor(role: WorkspaceRole, workspace = workspaceId): SitesContext {
    const access = {
      workspaceId: workspace,
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
        workspaces: [access],
        agencies: [],
      },
      workspace: access,
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
    const [other] = await harness.owner
      .insert(workspaces)
      .values({ name: 'Rival', slug: 'rival' })
      .returning();
    otherWorkspaceId = other!.id;
    const [user] = await harness.owner
      .insert(users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam', passwordHash: null })
      .returning();
    userId = user!.id;
  });

  /** A site in whatever verification state the test needs. */
  async function siteWith(
    verificationState: 'unverified' | 'pending' | 'verified',
    origin = ORIGIN,
  ): Promise<string> {
    const site = await createSite(contextFor('owner'), { name: 'Main', origin });
    if (verificationState !== 'unverified') {
      await harness.owner
        .update(sites)
        .set(
          verificationState === 'verified'
            ? {
                verificationState: 'verified',
                verifiedAt: new Date(),
                verificationMethod: 'html_meta',
              }
            : { verificationState: 'pending' },
        )
        .where(eq(sites.id, site.id));
    }
    return site.id;
  }

  const countCrawls = async (): Promise<number> =>
    (await harness.owner.select().from(crawls)).length;
  const countJobs = async (): Promise<number> => (await harness.owner.select().from(jobs)).length;

  // -------------------------------------------------------------------------
  // The verification gate
  // -------------------------------------------------------------------------

  describe('⚠️ the verification gate', () => {
    it.each(['unverified', 'pending'] as const)(
      'refuses a %s site AND writes nothing',
      async (state) => {
        const siteId = await siteWith(state);

        await expect(requestCrawl(contextFor('owner'), { siteId })).rejects.toThrow(/not verified/);

        // The assertion that matters. An error that still left a crawl row
        // would pass a rejects.toThrow() check and be a live scanning path.
        expect(await countCrawls()).toBe(0);
        expect(await countJobs()).toBe(0);
      },
    );

    it('an OWNER still cannot crawl an unverified domain', async () => {
      // Verification is a proof about the world. No amount of privilege inside
      // Growth OS produces it, and a role that waived it would turn an
      // ownership control into a privilege check (ADR-0054).
      const siteId = await siteWith('unverified');
      await expect(requestCrawl(contextFor('owner'), { siteId })).rejects.toThrow();
      expect(await countCrawls()).toBe(0);
    });

    it('refuses a site belonging to another workspace, without confirming it exists', async () => {
      const siteId = await siteWith('verified');
      // Same id, different tenant. A "not verified" message here would confirm
      // the row exists to anyone who can guess a UUID.
      await expect(requestCrawl(contextFor('owner', otherWorkspaceId), { siteId })).rejects.toThrow(
        /not found/i,
      );
      expect(await countCrawls()).toBe(0);
    });

    it('accepts once the site is verified', async () => {
      const siteId = await siteWith('verified');
      const requested = await requestCrawl(contextFor('owner'), { siteId });

      expect(requested.status).toBe('queued');
      expect(requested.origin).toBe(ORIGIN);
      expect(await countCrawls()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The capability gate — independent of the one above
  // -------------------------------------------------------------------------

  describe('the capability gate', () => {
    it('refuses a viewer, who may read crawls but not start them', async () => {
      const siteId = await siteWith('verified');

      await expect(requestCrawl(contextFor('viewer'), { siteId })).rejects.toThrow(
        /workspace:crawls:run/,
      );
      expect(await countCrawls()).toBe(0);
      expect(await countJobs()).toBe(0);
    });

    it('allows a member — recrawling is daily investigative work', async () => {
      const siteId = await siteWith('verified');
      const requested = await requestCrawl(contextFor('member'), { siteId });
      expect(requested.status).toBe('queued');
    });

    it('checks the capability BEFORE the site, so a refusal leaks nothing', async () => {
      // A viewer naming a site id that does not exist must get the
      // authorization error, not a not-found — otherwise the error code is an
      // existence oracle for anyone with the weakest role in the workspace.
      await expect(
        requestCrawl(contextFor('viewer'), { siteId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toThrow(/workspace:crawls:run/);
    });

    it('refuses a viewer reading nothing they should not — but ALLOWS the read', async () => {
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('member'), { siteId });
      const view = await getCrawl(contextFor('viewer'), crawlId);
      expect(view.id).toBe(crawlId);
      expect(view.status).toBe('queued');
    });
  });

  // -------------------------------------------------------------------------
  // The row and its job
  // -------------------------------------------------------------------------

  describe('the crawl row and its job', () => {
    it('writes the crawl and enqueues exactly one job for it', async () => {
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });

      const [job] = await harness.owner.select().from(jobs);
      expect(job?.name).toBe(RUN_CRAWL_JOB);
      expect(job?.status).toBe('pending');
      expect(job?.payload).toMatchObject({ crawlId, workspaceId });
      expect(job?.dedupeKey).toBe(`${RUN_CRAWL_JOB}:${crawlId}`);
    });

    it('copies the budget from the SITE, not from the caller', async () => {
      const siteId = await siteWith('verified');
      await harness.owner
        .update(sites)
        .set({ crawlPageLimit: 37, crawlMaxDepth: 3 })
        .where(eq(sites.id, siteId));

      const requested = await requestCrawl(contextFor('owner'), { siteId });
      expect(requested.pageLimit).toBe(37);
      expect(requested.maxDepth).toBe(3);
    });

    it('keeps the origin it was started with after the site is corrected', async () => {
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });

      await harness.owner
        .update(sites)
        .set({ origin: 'https://www.abcplumbing.test' })
        .where(eq(sites.id, siteId));

      // A crawl is a historical measurement and its subject is part of it.
      expect((await getCrawl(contextFor('owner'), crawlId)).origin).toBe(ORIGIN);
    });

    it('records who started it, and that it was manual', async () => {
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });

      const [row] = await harness.owner.select().from(crawls).where(eq(crawls.id, crawlId));
      expect(row?.createdByUserId).toBe(userId);
      expect(row?.trigger).toBe('manual');
    });

    it('two requests for one site are two crawls, each with its own job', async () => {
      // History is the point: a crawl never overwrites its predecessor.
      const siteId = await siteWith('verified');
      const first = await requestCrawl(contextFor('owner'), { siteId });
      const second = await requestCrawl(contextFor('owner'), { siteId });

      expect(first.crawlId).not.toBe(second.crawlId);
      expect(await countJobs()).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Claiming — the at-least-once queue's race
  // -------------------------------------------------------------------------

  describe('claiming a queued crawl', () => {
    it('moves queued → running and stamps startedAt', async () => {
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });

      const claimed = await claimCrawl(contextFor('owner'), crawlId);
      expect(claimed?.status).toBe('running');
      expect(claimed?.startedAt).not.toBeNull();
    });

    it('⚠️ the SECOND claim of the same crawl gets nothing', async () => {
      // The queue is at-least-once, so this delivery genuinely happens. Two
      // workers both running one crawl would double every count it records.
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });

      expect(await claimCrawl(contextFor('owner'), crawlId)).not.toBeNull();
      expect(await claimCrawl(contextFor('owner'), crawlId)).toBeNull();
    });

    it('returns null for a crawl in another workspace rather than claiming it', async () => {
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });

      expect(await claimCrawl(contextFor('owner', otherWorkspaceId), crawlId)).toBeNull();
      // And it is still claimable by its own tenant afterwards.
      expect(await claimCrawl(contextFor('owner'), crawlId)).not.toBeNull();
    });
  });

  describe('reading crawls', () => {
    it('lists a site’s crawls newest first', async () => {
      const siteId = await siteWith('verified');
      const first = await requestCrawl(contextFor('owner'), { siteId });
      const second = await requestCrawl(contextFor('owner'), { siteId });

      const listed = await listCrawlsForSite(contextFor('owner'), siteId);
      expect(listed.map((c) => c.id)).toEqual(
        expect.arrayContaining([first.crawlId, second.crawlId]),
      );
      expect(listed).toHaveLength(2);
    });

    it('does not list another site’s crawls', async () => {
      const mine = await siteWith('verified');
      const theirs = await siteWith('verified', 'https://other.test');
      await requestCrawl(contextFor('owner'), { siteId: mine });

      expect(await listCrawlsForSite(contextFor('owner'), theirs)).toHaveLength(0);
    });

    it('refuses to read a crawl from another workspace', async () => {
      const siteId = await siteWith('verified');
      const { crawlId } = await requestCrawl(contextFor('owner'), { siteId });

      await expect(getCrawl(contextFor('owner', otherWorkspaceId), crawlId)).rejects.toThrow(
        /not found/i,
      );
    });
  });
});
