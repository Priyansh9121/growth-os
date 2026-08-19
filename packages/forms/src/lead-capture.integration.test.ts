/**
 * Lead capture — the whole loop, against a real database.
 *
 * WHAT THIS SUITE IS FOR
 * Stage 3's product claim is that an anonymous visitor becomes a truthfully
 * attributed CRM lead through the SAME ingestion path every future channel will
 * use. That claim is transactional, tenant-scoped and idempotent, and none of
 * those can be demonstrated with a mock.
 *
 * Every assertion runs as the RESTRICTED, NON-OWNER role. A suite connected as
 * the migration role would pass while proving nothing about row-level security.
 *
 * THE NEGATIVES ARE THE POINT. "A submission creates a lead" would pass even if
 * the tenant were client-selectable, the source were client-assertable, a retry
 * created a second lead, and a paused form still accepted traffic.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  formVersionConfigSchema,
  publicSubmissionSchema,
  type CrmDomainEvent,
  type PublicSubmissionInput,
  type TenantActor,
  type WorkspaceRole,
} from '@growth-os/contracts';
import {
  assertRestrictedRole,
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { createForm, updateForm } from './forms/service';
import { createSite } from '@growth-os/sites';
import { NoChallengeVerifier } from './public/abuse';
import { resolvePublicForm, toPublicView } from './public/resolve';
import { submitPublicForm, type SubmitDependencies } from './public/submit';
import { listSubmissions } from './public/submissions';
import type { FormsContext } from './shared/context';

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const {
  acquisitions,
  activities,
  contacts,
  formSubmissions,
  forms,
  opportunities,
  pipelineStages,
  pipelines,
  workspaces,
} = schemaTables;

const APP_URL = 'https://app.growth-os.test';

describeIntegration('lead capture', () => {
  let harness: TestHarness;
  let workspaceA: string;
  let workspaceB: string;
  let userId: string;
  let published: CrmDomainEvent[];

  function contextFor(role: WorkspaceRole, workspaceId: string): FormsContext {
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
        name: 'Sam Whitfield',
        sessionId: 'test-session',
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
      correlationId: 'test-correlation',
    };
  }

  function submitDeps(): SubmitDependencies {
    return {
      db: harness.app as unknown as Database,
      events: { publish: (event) => published.push(event) },
      challenge: new NoChallengeVerifier(),
      appUrl: APP_URL,
    };
  }

  /** A complete, valid public submission. Overridden per test. */
  function submission(overrides: Partial<PublicSubmissionInput> = {}): PublicSubmissionInput {
    return publicSubmissionSchema.parse({
      values: {
        first_name: 'Priya',
        last_name: 'Raman',
        email: 'priya@example.test',
        phone: '0412 345 678',
        message: 'Burst pipe under the kitchen sink.',
      },
      submissionId: 'sub-0123456789abcdef',
      context: {
        landingPath: '/emergency-plumber',
        referrerOrigin: 'https://www.google.com',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'emergency-melbourne',
        gclid: 'TeSt-ClIcK-iD',
        elapsedMs: 18_400,
      },
      ...overrides,
    });
  }

  /** Create a published form and return its public key. */
  async function publishedForm(
    workspaceId: string,
    config?: Partial<{ opportunity: boolean; allowedOrigins: string[] }>,
  ): Promise<string> {
    const context = contextFor('owner', workspaceId);
    const form = await createForm(context, { name: 'Contact us' });

    if (config) {
      await updateForm(context, form.id, {
        config: formVersionConfigSchema.parse({
          fields: form.config!.fields,
          settings: {
            ...form.config!.settings,
            ...(config.opportunity
              ? { opportunity: { enabled: true, titleTemplate: '{contact} — {form}' } }
              : {}),
            ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
          },
        }),
      });
    }

    const live = await updateForm(context, form.id, { status: 'active' });
    return live.publicKey;
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    // Every submission below runs through `harness.app`, the RESTRICTED role.
    // A superuser or a table owner is EXEMPT from row-level security, so a
    // suite that connected as the migration role would pass while proving
    // nothing about the public path's isolation.
    await assertRestrictedRole(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    published = [];

    const spaces = await harness.owner
      .insert(workspaces)
      .values([
        { name: 'ABC Plumbing', slug: 'abc-plumbing' },
        { name: 'Meridian Legal', slug: 'meridian-legal' },
      ])
      .returning();
    workspaceA = spaces[0]!.id;
    workspaceB = spaces[1]!.id;

    const [user] = await harness.owner
      .insert(schemaTables.users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam Whitfield', passwordHash: null })
      .returning();
    userId = user!.id;

    // Both workspaces get a pipeline, so an opportunity rule has somewhere to
    // put a deal.
    for (const workspaceId of [workspaceA, workspaceB]) {
      const [pipeline] = await harness.owner
        .insert(pipelines)
        .values({ workspaceId, name: 'Sales', isDefault: true })
        .returning();
      await harness.owner.insert(pipelineStages).values({
        workspaceId,
        pipelineId: pipeline!.id,
        name: 'New Lead',
        position: 10,
        category: 'open',
      });
    }
  });

  // -------------------------------------------------------------------------
  // The headline loop
  // -------------------------------------------------------------------------

  describe('an anonymous submission becomes a CRM lead', () => {
    it('creates a contact, an acquisition, an activity and a receipt', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      expect(form).not.toBeNull();

      const result = await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      expect(result.kind).toBe('accepted');

      const [contact] = await harness.owner
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, workspaceA));

      expect(contact?.firstName).toBe('Priya');
      expect(contact?.email).toBe('priya@example.test');
      // ⚠️ NO USER CREATED THIS. A system path has no user, and writing a
      // fabricated id would violate the foreign key (ADR-0025 §2).
      expect(contact?.createdByUserId).toBeNull();

      const [acquisition] = await harness.owner
        .select()
        .from(acquisitions)
        .where(eq(acquisitions.contactId, contact!.id));

      expect(acquisition?.sourceType).toBe('paid_search');
      expect(acquisition?.landingPath).toBe('/emergency-plumber');

      const timeline = await harness.owner
        .select()
        .from(activities)
        .where(eq(activities.contactId, contact!.id));
      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline[0]?.actorType).toBe('automation');

      const [receipt] = await harness.owner
        .select()
        .from(formSubmissions)
        .where(eq(formSubmissions.workspaceId, workspaceA));
      expect(receipt?.outcome).toBe('created');
      expect(receipt?.contactId).toBe(contact!.id);
    });

    it('opens an opportunity when the form is configured to', async () => {
      const key = await publishedForm(workspaceA, { opportunity: true });
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      const [deal] = await harness.owner
        .select()
        .from(opportunities)
        .where(eq(opportunities.workspaceId, workspaceA));

      expect(deal?.title).toBe('Priya Raman — Contact us');
      // THE ATTRIBUTION JOIN, set at creation rather than inferred later.
      expect(deal?.acquisitionId).not.toBeNull();
    });

    it('attaches a second enquiry to the same person', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      const deps = submitDeps();

      await submitPublicForm(deps, {
        form: form!,
        input: submission({ submissionId: 'sub-first-0000000' }),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });
      await submitPublicForm(deps, {
        form: form!,
        input: submission({ submissionId: 'sub-second-000000' }),
        ipAddress: '203.0.113.11',
        origin: APP_URL,
        correlationId: null,
      });

      // Two acquisitions, ONE contact. A second visit must not overwrite the
      // first, and must not create a second person.
      expect(await harness.owner.select().from(contacts)).toHaveLength(1);
      expect(await harness.owner.select().from(acquisitions)).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('idempotency under retry', () => {
    it('a retried submission creates nothing further', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      const deps = submitDeps();

      const first = await submitPublicForm(deps, {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });
      const retry = await submitPublicForm(deps, {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      expect(first.kind).toBe('accepted');
      expect(retry.kind).toBe('accepted');

      // The whole point: a browser retry, a double-click or a proxy replay
      // must not inflate the lead count.
      expect(await harness.owner.select().from(contacts)).toHaveLength(1);
      expect(await harness.owner.select().from(acquisitions)).toHaveLength(1);

      const receipts = await harness.owner.select().from(formSubmissions);
      expect(receipts.map((r) => r.outcome).sort()).toEqual(['created', 'duplicate']);
    });

    it('does not re-publish the ingestion event on a retry', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      const deps = submitDeps();

      await submitPublicForm(deps, {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });
      published = [];
      await submitPublicForm(deps, {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      // Re-emitting would let a retry inflate downstream counters even though
      // the database correctly refused the second row.
      expect(published.filter((e) => e.name === 'crm.acquisition.ingested')).toHaveLength(0);
    });

    it('refuses the same submission id with different content', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      const deps = submitDeps();

      await submitPublicForm(deps, {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      // Silently replaying could attach one person's details to another's
      // acquisition. Conflict is the honest answer (ADR-0021 §3).
      await expect(
        submitPublicForm(deps, {
          form: form!,
          input: submission({
            values: {
              first_name: 'Someone',
              last_name: 'Else',
              email: 'else@example.test',
            },
          }),
          ipAddress: '203.0.113.10',
          origin: APP_URL,
          correlationId: null,
        }),
      ).rejects.toThrow();
    });

    it('scopes the idempotency key per FORM', async () => {
      // Two forms in one workspace, both receiving submission id "sub-1". The
      // second must not be discarded as a duplicate of the first.
      const keyOne = await publishedForm(workspaceA);
      const keyTwo = await publishedForm(workspaceA);
      const deps = submitDeps();

      for (const key of [keyOne, keyTwo]) {
        const form = await resolvePublicForm(harness.app as unknown as Database, key);
        await submitPublicForm(deps, {
          form: form!,
          input: submission({ submissionId: 'sub-collision-0001' }),
          ipAddress: '203.0.113.10',
          origin: APP_URL,
          correlationId: null,
        });
      }

      expect(await harness.owner.select().from(acquisitions)).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant safety
  // -------------------------------------------------------------------------

  describe('tenant safety', () => {
    it('the browser cannot choose the workspace — the key decides', async () => {
      const keyA = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, keyA);

      expect(form?.workspaceId).toBe(workspaceA);
      expect(form?.workspaceId).not.toBe(workspaceB);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      // The lead landed in A, and B has nothing.
      const inB = await harness.owner
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, workspaceB));
      expect(inB).toHaveLength(0);
    });

    it('a workspace cannot read another workspace’s forms', async () => {
      await publishedForm(workspaceB);

      const visible = await harness.app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', ${workspaceA}, true)`);
        return tx.select().from(forms);
      });

      expect(visible).toHaveLength(0);
    });

    it('the system grant holds exactly one capability', async () => {
      // If a bug ever routed a public submission into `eraseContact`, the
      // capability check refuses it — a materially different property from
      // "the code happens not to call that function" (ADR-0025 §1).
      const { systemCrmContext } = await import('./public/submit');
      const crm = systemCrmContext(submitDeps(), workspaceA, 'form-id', null);

      expect(crm.system?.capabilities).toEqual(['workspace:crm:contacts:write']);

      const { requireCapability } = await import('@growth-os/crm');
      expect(() => requireCapability(crm, 'workspace:crm:contacts:write')).not.toThrow();
      expect(() => requireCapability(crm, 'workspace:crm:contacts:erase')).toThrow();
      expect(() => requireCapability(crm, 'workspace:crm:contacts:merge')).toThrow();
      expect(() => requireCapability(crm, 'workspace:export')).toThrow();
    });

    it('actorUserId THROWS on a system context rather than improvising', async () => {
      const { systemCrmContext } = await import('./public/submit');
      const { actorUserId, actorUserIdOrNull } = await import('@growth-os/crm');
      const crm = systemCrmContext(submitDeps(), workspaceA, 'form-id', null);

      expect(() => actorUserId(crm)).toThrow(/system context/i);
      expect(actorUserIdOrNull(crm)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  describe('refusals', () => {
    it('a DRAFT form resolves to nothing at all', async () => {
      const context = contextFor('owner', workspaceA);
      const form = await createForm(context, { name: 'Not published' });

      // `published_version_id` is NULL and `resolve_public_form` INNER JOINs
      // it, so a never-published form is closed by construction rather than by
      // a status check somebody remembered to write.
      expect(
        await resolvePublicForm(harness.app as unknown as Database, form.publicKey),
      ).toBeNull();
    });

    it('a PAUSED form refuses, and records why for the operator', async () => {
      const key = await publishedForm(workspaceA);
      const context = contextFor('owner', workspaceA);
      const [row] = await harness.owner.select().from(forms).where(eq(forms.publicKey, key));
      await updateForm(context, row!.id, { status: 'inactive' });

      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      const result = await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      expect(result).toEqual({ kind: 'rejected', reason: 'form_not_accepting' });
      expect(await harness.owner.select().from(contacts)).toHaveLength(0);
    });

    it('an unknown key resolves to nothing', async () => {
      expect(
        await resolvePublicForm(harness.app as unknown as Database, 'f'.repeat(32)),
      ).toBeNull();
    });

    it('a malformed key never reaches the database', async () => {
      for (const bad of ['', 'short', '../../etc/passwd', "' OR 1=1--", 'A'.repeat(32)]) {
        expect(await resolvePublicForm(harness.app as unknown as Database, bad)).toBeNull();
      }
    });

    it('a filled honeypot refuses without creating a contact', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      const view = toPublicView(form!, key);

      const result = await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission({ trap: 'https://spam.test' }),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      expect(view.honeypotKey).toBeTruthy();
      expect(result).toEqual({ kind: 'rejected', reason: 'honeypot' });
      expect(await harness.owner.select().from(contacts)).toHaveLength(0);
    });

    it('an origin outside the allow-list refuses', async () => {
      const key = await publishedForm(workspaceA, {
        allowedOrigins: ['https://www.abcplumbing.test'],
      });
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      const result = await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: 'https://evil.test',
        correlationId: null,
      });

      expect(result).toEqual({ kind: 'rejected', reason: 'origin_not_allowed' });
    });

    it('the hosted form is permitted even when an allow-list is configured', async () => {
      // Otherwise configuring allowed origins silently breaks the hosted form
      // and the admin preview — a support call with no obvious cause.
      const key = await publishedForm(workspaceA, {
        allowedOrigins: ['https://www.abcplumbing.test'],
      });
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      const result = await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      expect(result.kind).toBe('accepted');
    });

    it('rate limits a flood, and records it', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      const deps = submitDeps();

      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await submitPublicForm(deps, {
          form: form!,
          input: submission({
            submissionId: `sub-flood-${attempt.toString().padStart(8, '0')}`,
            values: {
              first_name: 'Flood',
              email: `flood${attempt}@example.test`,
            },
          }),
          ipAddress: '198.51.100.7',
          origin: APP_URL,
          correlationId: null,
        });
        outcomes.push(result.kind);
      }

      expect(outcomes).toContain('rejected');
      // Far fewer than ten contacts were created.
      const created = await harness.owner.select().from(contacts);
      expect(created.length).toBeLessThan(10);
    });
  });

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  describe('provenance is derived, never asserted', () => {
    it('classifies a gclid submission as declared paid search', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      const [row] = await harness.owner.select().from(acquisitions);
      expect(row?.sourceType).toBe('paid_search');
      expect(row?.confidence).toBe('declared');
    });

    it('⚠️ never records a search query, whatever the browser sends', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission({
          context: {
            referrerOrigin: 'https://www.google.com/search?q=emergency+plumber+melbourne',
            utmTerm: 'emergency plumber melbourne',
            // Not in the schema, so it is stripped before it reaches here.
            searchQuery: 'emergency plumber melbourne',
            sourceType: 'organic_search',
            confidence: 'declared',
          } as never,
        }),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      const [row] = await harness.owner.select().from(acquisitions);

      // ⚠️ THE INVARIANT, stated precisely.
      //
      // `utm_term` IS retained — it is the marketer's own bid keyword, set on
      // their own ad link, and a real campaign fact worth reporting. What must
      // never happen is that value becoming `search_query`, which claims to be
      // what the VISITOR typed. The two differ constantly; broad match exists
      // precisely because they do (ADR-0012).
      expect(row?.utmTerm).toBe('emergency plumber melbourne');
      expect(row?.searchQuery).toBeNull();

      // The browser also claimed `sourceType: organic_search` and
      // `confidence: declared`. Neither is in the submission schema, so both
      // were stripped — and the SERVER classified it as organic search with
      // `derived` confidence, which is the honest reading of a Google referrer.
      expect(row?.sourceType).toBe('organic_search');
      expect(row?.confidence).toBe('derived');

      // The referrer was reduced to an ORIGIN, so the `?q=` is gone from it.
      expect(row?.referrerOrigin).toBe('https://www.google.com');
      expect(row?.referrerOrigin).not.toContain('emergency');
    });

    it('strips a query string from the landing path, which may carry PII', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission({
          context: { landingPath: '/booking?email=sarah@example.test&token=secret' },
        }),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      const [row] = await harness.owner.select().from(acquisitions);
      expect(row?.landingPath).toBe('/booking');
      expect(JSON.stringify(row)).not.toContain('sarah@example.test');
      expect(JSON.stringify(row)).not.toContain('secret');
    });

    // -----------------------------------------------------------------------
    // ⚠️ The shape check, asserted against the COLUMN — see ADR-0044
    // -----------------------------------------------------------------------

    it.each([
      ['a bare scheme-ish string', '::::'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a mailto: URL', 'mailto:a@b.test'],
      ['a tel: URL', 'tel:+61400000000'],
      ['a data: URL', 'data:text/html,<b>x</b>'],
      ['prose', 'not a url at all'],
      ['a traversal attempt', '../../etc/passwd'],
    ])('⚠️ does not store %s as a landing path', async (_label, hostile) => {
      // §6: the strong property is what reached the COLUMN, not what a
      // function returned. Each of these was previously written to
      // `acquisitions.landing_path` — `::::` as `/::::`, `javascript:alert(1)`
      // as `alert(1)` (dev log 0024, re-measured in 0025).
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      const result = await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission({ context: { landingPath: hostile } }),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      // ⚠️ THE LEAD IS STILL CAPTURED. A malformed referrer is ordinary
      // traffic; refusing the attribution must never refuse the customer.
      expect(result.kind).toBe('accepted');

      const [row] = await harness.owner.select().from(acquisitions);
      expect(row).toBeTruthy();
      expect(row?.landingPath).toBeNull();
    });

    it('still stores a landing path a real browser would send', async () => {
      // The negative control: the tracker sends `window.location.pathname`, so
      // the shape check must be invisible to every legitimate submission.
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission({
          context: { landingPath: '/blog/2026/03/fixing-a-tap?utm_source=google' },
        }),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      const [row] = await harness.owner.select().from(acquisitions);
      expect(row?.landingPath).toBe('/blog/2026/03/fixing-a-tap');
    });
  });

  // -------------------------------------------------------------------------
  // No raw payload
  // -------------------------------------------------------------------------

  describe('no raw payload is retained', () => {
    it('the receipt holds no submitted values', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      const [receipt] = await harness.owner.select().from(formSubmissions);
      const serialised = JSON.stringify(receipt);

      // A submission archive would be a second, richer copy of every enquiry a
      // business ever received, outside erasure's reach (ADR-0021 §4).
      expect(serialised).not.toContain('Priya');
      expect(serialised).not.toContain('priya@example.test');
      expect(serialised).not.toContain('0412');
      expect(serialised).not.toContain('Burst pipe');
    });

    it('the rate limiter stores a hash, never the IP', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.99',
        origin: APP_URL,
        correlationId: null,
      });

      const rows = await harness.owner.select().from(schemaTables.publicSubmissionLimits);
      expect(rows.length).toBeGreaterThan(0);
      // An operator with database access must not be able to read the
      // addresses of a customer's website visitors.
      expect(JSON.stringify(rows)).not.toContain('203.0.113.99');
    });

    it('the domain event carries no PII', async () => {
      const key = await publishedForm(workspaceA);
      const form = await resolvePublicForm(harness.app as unknown as Database, key);
      published = [];

      await submitPublicForm(submitDeps(), {
        form: form!,
        input: submission(),
        ipAddress: '203.0.113.10',
        origin: APP_URL,
        correlationId: null,
      });

      const serialised = JSON.stringify(published);
      expect(published.length).toBeGreaterThan(0);
      expect(serialised).not.toMatch(/priya|raman|0412|burst pipe/i);
    });
  });

  // -------------------------------------------------------------------------
  // Stored XSS
  // -------------------------------------------------------------------------

  it('stores a script-like value as inert text', async () => {
    const key = await publishedForm(workspaceA);
    const form = await resolvePublicForm(harness.app as unknown as Database, key);

    const payload = '<script>alert(document.cookie)</script>';
    await submitPublicForm(submitDeps(), {
      form: form!,
      input: submission({
        values: {
          first_name: payload,
          email: 'xss@example.test',
          message: '"><img src=x onerror=alert(1)>',
        },
      }),
      ipAddress: '203.0.113.10',
      origin: APP_URL,
      correlationId: null,
    });

    const [contact] = await harness.owner.select().from(contacts);
    // Stored VERBATIM, which is correct: escaping at write time corrupts real
    // data (a company genuinely called "Smith & Sons"). React escapes it at
    // render, and no CRM surface uses dangerouslySetInnerHTML.
    expect(contact?.firstName).toBe(payload);
  });

  // -------------------------------------------------------------------------
  // Form administration
  // -------------------------------------------------------------------------

  describe('form administration', () => {
    it('a member cannot manage forms', async () => {
      await expect(
        createForm(contextFor('member', workspaceA), { name: 'Nope' }),
      ).rejects.toThrow();
    });

    it('editing a published form creates a new VERSION', async () => {
      const context = contextFor('owner', workspaceA);
      const form = await createForm(context, { name: 'Contact us' });
      await updateForm(context, form.id, { status: 'active' });

      const edited = await updateForm(context, form.id, {
        config: formVersionConfigSchema.parse({
          fields: form.config!.fields,
          settings: { ...form.config!.settings, submitLabel: 'Get a quote' },
        }),
      });

      // A lead captured under version 1 keeps meaning what it meant.
      expect(edited.versions).toHaveLength(2);
      expect(edited.version).toBe(2);
    });

    it('refuses to publish a form that cannot identify a person', async () => {
      const context = contextFor('owner', workspaceA);
      const form = await createForm(context, { name: 'Broken' });

      await updateForm(context, form.id, {
        config: formVersionConfigSchema.parse({
          fields: [{ key: 'msg', type: 'textarea', label: 'Message', target: 'note' }],
          settings: {},
        }),
      });

      // Checked at PUBLISH, because discovering it from a lost enquiry is the
      // expensive way to learn it.
      await expect(updateForm(context, form.id, { status: 'active' })).rejects.toThrow(
        /Email or Phone/i,
      );
    });

    it('refuses two fields mapped to the same contact detail', async () => {
      const context = contextFor('owner', workspaceA);
      const form = await createForm(context, { name: 'Ambiguous' });

      await updateForm(context, form.id, {
        config: formVersionConfigSchema.parse({
          fields: [
            { key: 'a', type: 'text', label: 'Name', target: 'firstName' },
            { key: 'b', type: 'text', label: 'Also name', target: 'firstName' },
            { key: 'c', type: 'email', label: 'Email', target: 'email' },
          ],
          settings: {},
        }),
      });

      // Whichever ran last would win — a silent data-loss bug rather than an
      // error.
      await expect(updateForm(context, form.id, { status: 'active' })).rejects.toThrow(
        /Only one field/i,
      );
    });

    it('rotating the public key invalidates the old one', async () => {
      const key = await publishedForm(workspaceA);
      const { rotatePublicKey } = await import('./forms/service');
      const [row] = await harness.owner.select().from(forms).where(eq(forms.publicKey, key));

      const rotated = await rotatePublicKey(contextFor('owner', workspaceA), row!.id);

      expect(rotated.publicKey).not.toBe(key);
      expect(await resolvePublicForm(harness.app as unknown as Database, key)).toBeNull();
      expect(
        await resolvePublicForm(harness.app as unknown as Database, rotated.publicKey),
      ).not.toBeNull();
    });

    it('a site origin is normalised before it is stored', async () => {
      const site = await createSite(contextFor('owner', workspaceA), {
        name: 'Main',
        origin: 'ABCPlumbing.test/contact?utm=1',
      });

      expect(site.origin).toBe('https://abcplumbing.test');
      // Stage 3 requires only `unverified`; Stage 4 tightens it.
      expect(site.verificationState).toBe('unverified');
    });
  });

  // -------------------------------------------------------------------------
  // The operator's view
  // -------------------------------------------------------------------------

  it('the submissions list links to the contact without copying it', async () => {
    const key = await publishedForm(workspaceA);
    const form = await resolvePublicForm(harness.app as unknown as Database, key);
    await submitPublicForm(submitDeps(), {
      form: form!,
      input: submission(),
      ipAddress: '203.0.113.10',
      origin: APP_URL,
      correlationId: null,
    });

    const [row] = await harness.owner.select().from(forms).where(eq(forms.publicKey, key));
    const list = await listSubmissions(contextFor('owner', workspaceA), row!.id);

    expect(list).toHaveLength(1);
    expect(list[0]?.contactId).toBeTruthy();
    // The name is JOINED at read time, not stored on the receipt — so after an
    // erasure this list shows "Erased contact" rather than preserving a name
    // the erasure was supposed to remove.
    expect(list[0]?.contactName).toBe('Priya Raman');
    expect(list[0]?.sourceType).toBe('paid_search');
  });
});
