/**
 * `seo_findings` at the DATABASE layer — isolation, and the constraints that
 * make a finding evidence rather than an opinion.
 *
 * WHY THESE ARE DATABASE TESTS AND NOT SERVICE TESTS
 * Every rule below is enforced in exactly one place — PostgreSQL. A test that
 * asserted "the audit service validates it" would be asserting about a code
 * path, and there are already two ways to write this table (the service, and a
 * hand-run fix) with more to come. AGENTS.md §6: not "validation ran" but "the
 * row was refused by the database".
 *
 * The headline is `seo_findings_crawl_page_rule_unique`. It is this table's
 * ROW BOUND — the ceiling AGENTS.md §5 requires, expressed as an index because
 * a CHECK constraint sees one row and cannot count a table — and it is the
 * retry guarantee at the same time. `refuses a second finding of the same rule
 * for the same page in the same crawl` is the test that proves it.
 *
 * Every isolation test connects as a RESTRICTED, NON-OWNER role and calls
 * `assertRestrictedRole` first — superusers are exempt from RLS
 * unconditionally, so a suite connecting as the migration role would pass every
 * assertion while proving nothing.
 *
 * @see packages/database/migrations/0015_seo_findings.sql
 * @see docs/decisions/ADR-0070-findings-belong-to-a-crawl.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  type TestHarness,
} from './testing/harness';
import { TENANT_SETTING } from './client';
import { seoFindings } from './schema/seo';
import { crawlPages, crawls, sitePages } from './schema/crawl';
import { sites } from './schema/sites';
import { workspaces } from './schema/tenancy';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const ORIGIN_A = 'https://abcplumbing.test';
const ORIGIN_B = 'https://meridianlegal.test';

/**
 * The SQLSTATE and constraint a rejected write cited.
 *
 * ⚠️ "IT THREW" IS THE WEAK PROPERTY (§6). Drizzle wraps the driver error, so
 * asserting on `message` would pass for a typo or a null violation just as
 * happily as for the constraint under test. The driver error hangs off `cause`;
 * 23514 is `check_violation` and 23505 is `unique_violation`.
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

describeIntegration('seo_findings — isolation and the constraints on a finding', () => {
  let harness: TestHarness;
  let workspaceA: string;
  let workspaceB: string;
  let crawlA: string;
  let crawlA2: string;
  let crawlB: string;
  let pageA: string;
  let pageA2: string;
  let pageB: string;

  /** Everything one workspace needs to own a finding: site, crawl(s), page. */
  async function seedWorkspace(
    workspaceId: string,
    origin: string,
    crawlCount: number,
  ): Promise<{ crawlIds: string[]; pageIds: string[] }> {
    const [site] = await harness.owner
      .insert(sites)
      .values({
        workspaceId,
        name: 'Main',
        origin,
        verificationState: 'verified',
        verifiedAt: new Date(),
        verificationMethod: 'html_meta',
      })
      .returning();

    const crawlRows = await harness.owner
      .insert(crawls)
      .values(
        Array.from({ length: crawlCount }, () => ({
          workspaceId,
          siteId: site!.id,
          origin,
          pageLimit: 50,
          maxDepth: 5,
          trigger: 'manual' as const,
          status: 'running' as const,
          startedAt: new Date(),
        })),
      )
      .returning();

    const pageRows = await harness.owner
      .insert(sitePages)
      .values([
        { workspaceId, siteId: site!.id, normalisedUrl: `${origin}/` },
        { workspaceId, siteId: site!.id, normalisedUrl: `${origin}/hidden` },
      ])
      .returning();

    return { crawlIds: crawlRows.map((r) => r.id), pageIds: pageRows.map((r) => r.id) };
  }

  const finding = (overrides: Partial<typeof seoFindings.$inferInsert> = {}) =>
    ({
      workspaceId: workspaceA,
      crawlId: crawlA,
      sitePageId: pageA,
      rule: 'orphan_page' as const,
      evidence: { internalInboundLinks: 0, pagesConsidered: 12 },
      ...overrides,
    }) satisfies typeof seoFindings.$inferInsert;

  beforeAll(async () => {
    harness = await createTestHarness();
    // If this throws, every isolation assertion below would be meaningless.
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
    workspaceA = inserted[0]!.id;
    workspaceB = inserted[1]!.id;

    const a = await seedWorkspace(workspaceA, ORIGIN_A, 2);
    crawlA = a.crawlIds[0]!;
    crawlA2 = a.crawlIds[1]!;
    pageA = a.pageIds[0]!;
    pageA2 = a.pageIds[1]!;

    const b = await seedWorkspace(workspaceB, ORIGIN_B, 1);
    crawlB = b.crawlIds[0]!;
    pageB = b.pageIds[0]!;
  });

  /**
   * Run as the restricted role, scoped to one workspace, as production does.
   *
   * ⚠️ `TENANT_SETTING` IS IMPORTED, NOT RETYPED. This helper was first written
   * with the literal `'app.current_workspace_id'` — the name of the SQL
   * *function* the policies call, not of the setting that function reads
   * (`app.workspace_id`). The scope then silently stayed NULL, and the
   * consequence is why the constant is imported now: `refuses a write stamped
   * with another workspace id` PASSED anyway, because an unscoped transaction
   * fails closed and refuses every insert. A green isolation test that proves
   * nothing is the exact failure `assertRestrictedRole` exists to prevent, so
   * the setting name must not be a string this file can get wrong on its own.
   */
  async function asTenant<T>(workspaceId: string, fn: (tx: never) => Promise<T>): Promise<T> {
    return harness.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${TENANT_SETTING}, ${workspaceId}, true)`);
      return fn(tx as never);
    });
  }

  describe('the row bound — one finding per rule per page per crawl', () => {
    it('⚠️ refuses a second finding of the same rule for the same page in the same crawl', async () => {
      // THE ROW BOUND. AGENTS.md §5 requires the limit to live in the database,
      // and a per-crawl row CEILING cannot be a CHECK — a CHECK is evaluated
      // against one row and cannot count a table. This index is the bound
      // instead: one row per retrieved page, and `crawls_budget_is_bounded`
      // already caps pages at 10,000.
      await harness.owner.insert(seoFindings).values(finding());

      const refusal = await refusalOf(
        harness.owner.insert(seoFindings).values(
          // A DIFFERENT measurement for the same (crawl, page, rule). The
          // second row must not land: it would double the finding on a re-audit
          // and there would be no way to tell which count was current.
          finding({ evidence: { internalInboundLinks: 0, pagesConsidered: 99 } }),
        ),
      );

      expect(refusal.code).toBe('23505');
      expect(refusal.constraint).toBe('seo_findings_crawl_page_rule_unique');
    });

    it('allows the same page to be found again by a LATER crawl — that is the history', async () => {
      // The point of the per-crawl lifetime. "Still orphaned on Thursday" is
      // two rows sharing a `site_page_id`, not one row with a mutable date.
      await harness.owner
        .insert(seoFindings)
        .values([
          finding({ crawlId: crawlA, evidence: { internalInboundLinks: 0, pagesConsidered: 12 } }),
          finding({ crawlId: crawlA2, evidence: { internalInboundLinks: 0, pagesConsidered: 14 } }),
        ]);

      const rows = await harness.owner.select().from(seoFindings);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.sitePageId))).toEqual(new Set([pageA]));
      expect(new Set(rows.map((r) => r.crawlId))).toEqual(new Set([crawlA, crawlA2]));
    });

    it('allows two pages to be found by the same crawl', async () => {
      await harness.owner
        .insert(seoFindings)
        .values([finding({ sitePageId: pageA }), finding({ sitePageId: pageA2 })]);

      expect(await harness.owner.select().from(seoFindings)).toHaveLength(2);
    });
  });

  describe('evidence — a finding that decided nothing is not a finding', () => {
    it('refuses evidence that is not a JSON object', async () => {
      // `jsonb NOT NULL` accepts `42`, `"orphaned"` and `null`-the-JSON-value.
      // None of them states what was measured. Raw SQL specifically so the
      // TypeScript types cannot be what stops it.
      for (const literal of ['42', '"orphaned"', 'null', '[1,2]']) {
        const refusal = await refusalOf(
          harness.owner.execute(sql`
            INSERT INTO seo_findings (workspace_id, crawl_id, site_page_id, rule, evidence)
            VALUES (${workspaceA}::uuid, ${crawlA}::uuid, ${pageA}::uuid, 'orphan_page',
                    ${literal}::jsonb)
          `),
        );
        expect(refusal.code, `evidence ${literal} was ACCEPTED`).toBe('23514');
        expect(refusal.constraint).toBe('seo_findings_evidence_is_a_bounded_object');
      }
    });

    it('refuses an empty object — the rule recorded no deciding fact', async () => {
      const refusal = await refusalOf(
        harness.owner.insert(seoFindings).values(finding({ evidence: {} })),
      );

      expect(refusal.code).toBe('23514');
      expect(refusal.constraint).toBe('seo_findings_evidence_is_a_bounded_object');
    });

    it('refuses evidence over 4 KB — a bug in a rule must not store a page of prose', async () => {
      const refusal = await refusalOf(
        harness.owner.insert(seoFindings).values(finding({ evidence: { note: 'x'.repeat(4096) } })),
      );

      expect(refusal.code).toBe('23514');
      expect(refusal.constraint).toBe('seo_findings_evidence_is_a_bounded_object');
    });

    it('accepts the deciding fact an orphan_page finding actually carries', async () => {
      await harness.owner.insert(seoFindings).values(finding());

      const [row] = await harness.owner.select().from(seoFindings);
      expect(row?.evidence).toEqual({ internalInboundLinks: 0, pagesConsidered: 12 });
      expect(row?.rule).toBe('orphan_page');
      expect(row?.detectedAt).toBeInstanceOf(Date);
    });
  });

  describe('tenant isolation', () => {
    it('shows a workspace only its own findings', async () => {
      await harness.owner
        .insert(seoFindings)
        .values([
          finding(),
          finding({ workspaceId: workspaceB, crawlId: crawlB, sitePageId: pageB }),
        ]);

      const seen = await asTenant(workspaceA, async (tx) =>
        (tx as unknown as TestHarness['app']).select().from(seoFindings),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]?.workspaceId).toBe(workspaceA);
    });

    it('refuses a write stamped with another workspace id', async () => {
      // The INSERT policy's WITH CHECK. A service that got the workspace wrong
      // must be stopped by the database, not by remembering to check.
      //
      // ⚠️ THE SQLSTATE, NOT `.rejects.toThrow()` (§6). The crawl and page here
      // belong to workspace B and exist, so a bare "it threw" would pass just
      // as happily for a foreign key or a NOT NULL violation — and did pass,
      // vacuously, while `asTenant` was setting the wrong setting name and no
      // scope was ever established. 42501 is `insufficient_privilege`, which is
      // what a WITH CHECK refusal raises and what nothing else here raises.
      const refusal = await refusalOf(
        asTenant(workspaceA, async (tx) =>
          (tx as unknown as TestHarness['app'])
            .insert(seoFindings)
            .values(finding({ workspaceId: workspaceB, crawlId: crawlB, sitePageId: pageB })),
        ),
      );

      expect(refusal.code).toBe('42501');
    });

    it('⚠️ has RLS both ENABLED and FORCED', async () => {
      // FORCE is what closes the table-owner exemption. Without it the policies
      // above are decorative for anything connecting as the migration role.
      const result = await harness.owner.execute<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname = 'seo_findings'
      `);

      expect(result[0]?.relrowsecurity, 'seo_findings RLS not ENABLED').toBe(true);
      expect(result[0]?.relforcerowsecurity, 'seo_findings RLS not FORCED').toBe(true);
    });

    it('⚠️ grants no UPDATE and no DELETE policy — a finding is evidence, not a draft', async () => {
      // Absence is the assertion. A policy added later would silently make
      // findings editable, and an interpretation that can be edited after the
      // fact is not a record of what a rule concluded.
      const policies = await harness.owner.execute<{ polcmd: string }>(sql`
        SELECT polcmd FROM pg_policy WHERE polrelid = 'seo_findings'::regclass
      `);

      // 'r' = SELECT, 'a' = INSERT, 'w' = UPDATE, 'd' = DELETE.
      expect(policies.map((p) => p.polcmd).sort()).toEqual(['a', 'r']);
    });
  });

  describe('the crawl owns the finding', () => {
    it('deletes findings with the crawl that produced them', async () => {
      // The per-crawl lifetime, enforced by the foreign key. A finding whose
      // crawl is gone has nothing to explain it.
      await harness.owner.insert(seoFindings).values(finding());
      await harness.owner.execute(sql`DELETE FROM crawls WHERE id = ${crawlA}::uuid`);

      expect(await harness.owner.select().from(seoFindings)).toHaveLength(0);
    });

    it('refuses a finding about no particular page', async () => {
      // `site_page_id` is NOT NULL here where `crawl_pages.site_page_id` is
      // nullable. A failed fetch is still evidence; a finding about nothing is
      // not. Raw SQL so the types are not what stops it.
      const refusal = await refusalOf(
        harness.owner.execute(sql`
          INSERT INTO seo_findings (workspace_id, crawl_id, site_page_id, rule, evidence)
          VALUES (${workspaceA}::uuid, ${crawlA}::uuid, NULL, 'orphan_page', '{"a":1}'::jsonb)
        `),
      );

      expect(refusal.code).toBe('23502');
    });
  });

  it('is not reachable from a crawl_pages row alone — the join is through site_pages', async () => {
    // Guards the ADR-0070 decision that the finding points at the DURABLE page.
    // If someone re-points `site_page_id` at `crawl_pages`, this fails: the ids
    // come from different tables and a crawl_pages id is not a site_pages id.
    const [observation] = await harness.owner
      .insert(crawlPages)
      .values({
        workspaceId: workspaceA,
        crawlId: crawlA,
        siteId: (await harness.owner.select().from(sites).limit(1))[0]!.id,
        sitePageId: pageA,
        normalisedUrl: `${ORIGIN_A}/`,
        depth: 0,
        outcome: 'fetched',
        httpStatus: 200,
      })
      .returning();

    const refusal = await refusalOf(
      harness.owner.insert(seoFindings).values(finding({ sitePageId: observation!.id })),
    );

    expect(refusal.code).toBe('23503');
    expect(refusal.constraint).toBe('seo_findings_site_page_id_site_pages_id_fk');
  });
});
