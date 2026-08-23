/**
 * Writing the link graph, against a real database.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * Three of the properties here are the database's and nothing else's: the
 * anchor-text CHECK, the foreign key onto `crawl_pages`, and row-level
 * security. A mock would assert that the code calls Drizzle, which is not what
 * anyone is worried about.
 *
 * Every assertion runs as the RESTRICTED, NON-OWNER role. A suite connected as
 * the migration role is exempt from RLS and would pass while proving nothing.
 *
 * @see docs/decisions/ADR-0067-the-observation-id-is-the-retry-signal.md
 * @see docs/decisions/ADR-0069-discovered-links-become-frontier-candidates.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  withTenantTransaction,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { recordLinks } from './record';
import { MAX_ANCHOR_TEXT_LENGTH, type ExtractedLink } from './extract';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { crawlLinks, crawlPages, crawls, sitePages, sites, workspaces } = schemaTables;

const ORIGIN = 'https://example.test';

/**
 * The SQLSTATE and constraint a rejected write cited.
 *
 * ⚠️ "IT THREW" IS THE WEAK PROPERTY (§6). Drizzle wraps the driver error, so
 * asserting on `message` would pass for a typo or a null violation. The driver
 * error hangs off `cause`; 23514 is `check_violation`.
 */
async function refusalOf(write: Promise<unknown>): Promise<{ code: string; constraint: string }> {
  try {
    await write;
  } catch (error) {
    const cause = (error as { cause?: Record<string, unknown> }).cause ?? {};
    return { code: String(cause['code']), constraint: String(cause['constraint_name']) };
  }
  throw new Error('the database ACCEPTED a row it should have refused');
}

const link = (overrides: Partial<ExtractedLink> = {}): ExtractedLink => ({
  targetUrl: `${ORIGIN}/about`,
  scope: 'internal',
  anchorText: 'About us',
  isNofollow: false,
  ...overrides,
});

describeIntegration('recording the link graph', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let crawlId: string;
  let crawlPageId: string;

  async function inTenant<T>(
    fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
    workspace = workspaceId,
  ): Promise<T> {
    return withTenantTransaction(harness.app as unknown as Database, workspace, fn);
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

    const inserted = await harness.owner
      .insert(workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing' },
        { name: 'Meridian Legal', slug: 'meridian-legal' },
      ])
      .returning();
    workspaceId = inserted[0]!.id;
    otherWorkspaceId = inserted[1]!.id;

    const [site] = await harness.owner
      .insert(sites)
      .values({
        workspaceId,
        name: 'Main',
        origin: ORIGIN,
        verificationState: 'verified',
        verifiedAt: new Date(),
        verificationMethod: 'html_meta',
      })
      .returning();

    const [crawl] = await harness.owner
      .insert(crawls)
      .values({
        workspaceId,
        siteId: site!.id,
        origin: ORIGIN,
        pageLimit: 50,
        maxDepth: 5,
        trigger: 'manual',
        status: 'running',
        startedAt: new Date(),
      })
      .returning();
    crawlId = crawl!.id;

    const [page] = await harness.owner
      .insert(sitePages)
      .values({
        workspaceId,
        siteId: site!.id,
        normalisedUrl: `${ORIGIN}/`,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning();

    const [observation] = await harness.owner
      .insert(crawlPages)
      .values({
        workspaceId,
        crawlId,
        siteId: site!.id,
        sitePageId: page!.id,
        normalisedUrl: `${ORIGIN}/`,
        depth: 0,
        fetchedAt: new Date(),
        outcome: 'fetched',
        httpStatus: 200,
      })
      .returning();
    crawlPageId = observation!.id;
  });

  describe('what is written', () => {
    it('writes one row per link, with every fact the document stated', async () => {
      const written = await inTenant((tx) =>
        recordLinks(tx, workspaceId, {
          crawlId,
          sourcePageId: crawlPageId,
          links: [
            link({ targetUrl: `${ORIGIN}/about`, anchorText: 'About us' }),
            link({
              targetUrl: 'https://supplier.test/x',
              scope: 'external',
              anchorText: null,
              isNofollow: true,
            }),
          ],
        }),
      );

      expect(written).toBe(2);

      const rows = await harness.owner.select().from(crawlLinks);
      expect(rows).toHaveLength(2);

      const internal = rows.find((r) => r.targetUrl === `${ORIGIN}/about`);
      expect(internal?.scope).toBe('internal');
      expect(internal?.anchorText).toBe('About us');
      expect(internal?.isNofollow).toBe(false);
      expect(internal?.sourcePageId).toBe(crawlPageId);
      expect(internal?.crawlId).toBe(crawlId);

      const external = rows.find((r) => r.targetUrl === 'https://supplier.test/x');
      expect(external?.scope).toBe('external');
      expect(external?.anchorText).toBeNull();
      expect(external?.isNofollow).toBe(true);
    });

    it('writes nothing, and touches nothing, for a page with no links', async () => {
      const written = await inTenant((tx) =>
        recordLinks(tx, workspaceId, { crawlId, sourcePageId: crawlPageId, links: [] }),
      );

      expect(written).toBe(0);
      expect(await harness.owner.select().from(crawlLinks)).toHaveLength(0);
    });

    it('⚠️ keeps two edges to the same target — they are two facts, not a duplicate', async () => {
      // The nav and the footer both link to /contact, with different anchor
      // text. Collapsing them would make an anchor-text distribution
      // uncomputable, which is one of the questions ADR-0034 says this table
      // exists to answer (ADR-0069, alternative C).
      await inTenant((tx) =>
        recordLinks(tx, workspaceId, {
          crawlId,
          sourcePageId: crawlPageId,
          links: [
            link({ targetUrl: `${ORIGIN}/contact`, anchorText: 'Contact' }),
            link({ targetUrl: `${ORIGIN}/contact`, anchorText: 'Get a quote' }),
          ],
        }),
      );

      const rows = await harness.owner.select().from(crawlLinks);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.anchorText).sort()).toEqual(['Contact', 'Get a quote']);
    });

    it('⚠️ writes more rows than fit in one statement — the chunk boundary', async () => {
      // INSERT_CHUNK is 500. 1,200 crosses it three times, which is what
      // catches an off-by-one that would drop or repeat a chunk.
      const many = Array.from({ length: 1_200 }, (_, i) =>
        link({ targetUrl: `${ORIGIN}/p/${i}`, anchorText: `Page ${i}` }),
      );

      const written = await inTenant((tx) =>
        recordLinks(tx, workspaceId, { crawlId, sourcePageId: crawlPageId, links: many }),
      );

      expect(written).toBe(1_200);
      const rows = await harness.owner.select().from(crawlLinks);
      expect(rows).toHaveLength(1_200);
      expect(new Set(rows.map((r) => r.targetUrl)).size).toBe(1_200);
    });
  });

  describe("⚠️ the anchor-text bound is the database's, not the extractor's", () => {
    /**
     * ⚠️ THE ROW THAT MUST BE REFUSED (AGENTS.md §5).
     *
     * `MAX_ANCHOR_TEXT_LENGTH` was 512 against a column that refuses anything
     * over 300 — reachable only once something inserted a link, which is this
     * module. The unit test in `extract.test.ts` proves the extractor never
     * produces one; this proves what would happen if it did, so lowering the
     * constant is provably not the only thing standing between a long anchor
     * and a rolled-back page transaction.
     */
    it('refuses an anchor of 301 characters, citing the constraint', async () => {
      const refusal = await refusalOf(
        inTenant((tx) =>
          recordLinks(tx, workspaceId, {
            crawlId,
            sourcePageId: crawlPageId,
            links: [link({ anchorText: 'y'.repeat(301) })],
          }),
        ),
      );

      expect(refusal.code).toBe('23514');
      expect(refusal.constraint).toBe('crawl_links_anchor_text_is_bounded');
    });

    it('accepts an anchor of exactly 300, which is what the extractor now emits', async () => {
      expect(MAX_ANCHOR_TEXT_LENGTH).toBe(300);

      const written = await inTenant((tx) =>
        recordLinks(tx, workspaceId, {
          crawlId,
          sourcePageId: crawlPageId,
          links: [link({ anchorText: 'y'.repeat(MAX_ANCHOR_TEXT_LENGTH) })],
        }),
      );

      expect(written).toBe(1);
    });
  });

  describe('⚠️ tenancy', () => {
    it("another workspace cannot read this workspace's link graph", async () => {
      await inTenant((tx) =>
        recordLinks(tx, workspaceId, {
          crawlId,
          sourcePageId: crawlPageId,
          links: [link()],
        }),
      );

      const mine = await inTenant((tx) =>
        tx.select().from(crawlLinks).where(eq(crawlLinks.crawlId, crawlId)),
      );
      expect(mine).toHaveLength(1);

      // Same query, same crawl id, different tenant. RLS is FORCE, so this is
      // empty rather than forbidden.
      const theirs = await inTenant(
        (tx) => tx.select().from(crawlLinks).where(eq(crawlLinks.crawlId, crawlId)),
        otherWorkspaceId,
      );
      expect(theirs).toHaveLength(0);
    });

    it('⚠️ refuses to write a row into another tenant, even when told to', async () => {
      // The INSERT policy's WITH CHECK, not application validation.
      const refusal = await refusalOf(
        inTenant((tx) =>
          recordLinks(tx, otherWorkspaceId, {
            crawlId,
            sourcePageId: crawlPageId,
            links: [link()],
          }),
        ),
      );

      expect(refusal.code).toBe('42501');
      expect(await harness.owner.select().from(crawlLinks)).toHaveLength(0);
    });
  });
});
