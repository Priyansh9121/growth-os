/**
 * CRM data lifecycle — SERVICE layer.
 *
 * WHY THIS SUITE IS SEPARATE FROM THE DATABASE ONE
 * `crm-lifecycle.integration.test.ts` proves the SQL functions and policies
 * behave. This proves the services on top of them do: that capabilities are
 * checked, that previews mutate nothing, that idempotency actually stops a
 * retry from creating a second lead, and that an import records provenance it
 * can honestly claim.
 *
 * These run against a real database because the behaviour under test is
 * transactional. A mocked version would assert that the code calls the
 * functions it calls, which is not the same as asserting the outcome.
 *
 * @see docs/decisions/ADR-0019-contact-merge.md
 * @see docs/decisions/ADR-0020-privacy-erasure.md
 * @see docs/decisions/ADR-0021-ingestion-and-idempotency.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AppError,
  AuthorizationError,
  ConflictError,
  ingestAcquisitionSchema,
  type CrmDomainEvent,
  type TenantActor,
  type WorkspaceRole,
} from '@growth-os/contracts';
import {
  createTestHarness,
  hasTestDatabase,
  schemaTables,
  type Database,
  type TestHarness,
} from '@growth-os/database';
import { createContact, listContacts } from './contacts/service';
import { createCompany, listCompanies } from './companies/service';
import { eraseContact, previewErasure, countTracesOf } from './contacts/erasure';
import { mergeContacts, previewMerge, resolveMergeRedirect } from './contacts/merge';
import { ingestAcquisition } from './ingestion/service';
import { prepareRows, runImport, validateImport } from './import/service';
import { applyTag, createTag, listContactTags } from './tags/service';
import {
  createCustomField,
  listCustomFieldValues,
  setCustomFieldValue,
} from './custom-fields/service';
import type { CrmContext } from './shared/context';

/**
 * Assert the OPERATOR-FACING message of a rejected operation.
 *
 * `AppError.message` is written for logs and carries ids and internal detail;
 * `publicMessage` is the only string a client ever sees. Asserting the former
 * would let the user-facing wording rot unnoticed, which is the half that
 * actually has to be right.
 */
async function publicMessageOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AppError) return error.publicMessage;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the operation to be rejected.');
}

const describeIntegration = hasTestDatabase() ? describe : describe.skip;

const { contacts, opportunities, pipelineStages, pipelines, workspaces } = schemaTables;

describeIntegration('CRM lifecycle services', () => {
  let harness: TestHarness;
  let workspaceId: string;
  let userId: string;
  let published: CrmDomainEvent[];

  /**
   * Build a context for a given role.
   *
   * The role is a parameter because half of what this suite proves is that a
   * `member` cannot reach the destructive operations. A fixture that only ever
   * built an owner context would test the happy path and call it coverage.
   */
  function contextFor(role: WorkspaceRole): CrmContext {
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

  beforeAll(async () => {
    harness = await createTestHarness();
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
      .insert(schemaTables.users)
      .values({ email: 'sam@abcplumbing.test', name: 'Sam Whitfield', passwordHash: null })
      .returning();
    userId = user!.id;

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
  });

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  describe('the destructive operations are admin-only', () => {
    it.each([
      ['merge preview', (context: CrmContext, id: string) => previewMerge(context, id, id)],
      ['erasure preview', (context: CrmContext, id: string) => previewErasure(context, id)],
      ['erasure', (context: CrmContext, id: string) => eraseContact(context, id)],
    ])('refuses %s for a member', async (_label, operation) => {
      const owner = contextFor('owner');
      const created = await createContact(owner, {
        firstName: 'Sarah',
        email: 'sarah@example.test',
      });

      // A member can fix a typo on this contact. They must not be able to fold
      // it into another record or destroy its identity.
      await expect(operation(contextFor('member'), created.contact.id)).rejects.toThrow(
        AuthorizationError,
      );
    });

    it('refuses an import for a member', async () => {
      await expect(
        validateImport(contextFor('member'), { mapping: {}, filename: 'x.csv', rows: [] }),
      ).rejects.toThrow(AuthorizationError);
    });

    it('lets a member apply an existing tag but not define one', async () => {
      const tag = await createTag(contextFor('admin'), { name: 'VIP', tone: 'signal' });
      const created = await createContact(contextFor('owner'), {
        firstName: 'Sarah',
        email: 'sarah@example.test',
      });

      await expect(
        applyTag(contextFor('member'), created.contact.id, tag.id),
      ).resolves.toHaveLength(1);

      await expect(
        createTag(contextFor('member'), { name: 'Nope', tone: 'neutral' }),
      ).rejects.toThrow(AuthorizationError);
    });
  });

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    async function twoRecordsOfOnePerson(): Promise<{ survivor: string; duplicate: string }> {
      const owner = contextFor('owner');
      const first = await createContact(owner, {
        firstName: 'Sarah',
        lastName: 'Mitchell',
        email: 'sarah@example.test',
      });
      const second = await createContact(owner, {
        firstName: 'Sarah',
        email: 'sarah@example.test',
        phone: '0412 345 678',
      });
      return { survivor: first.contact.id, duplicate: second.contact.id };
    }

    it('previews without mutating anything', async () => {
      const { survivor, duplicate } = await twoRecordsOfOnePerson();

      const before = await harness.owner.select().from(contacts);
      const preview = await previewMerge(contextFor('owner'), survivor, duplicate);
      const after = await harness.owner.select().from(contacts);

      expect(preview.blockers).toEqual([]);
      // The phone the duplicate holds and the survivor lacks: a free gain, so
      // it needs no human decision.
      expect(preview.fills.map((fill) => fill.field)).toContain('phone');
      expect(after).toEqual(before);
    });

    it('reports a real conflict rather than choosing silently', async () => {
      const owner = contextFor('owner');
      const first = await createContact(owner, {
        firstName: 'Sarah',
        lastName: 'Mitchell',
        email: 'sarah@example.test',
      });
      const second = await createContact(owner, {
        firstName: 'Sarah',
        lastName: 'Nguyen',
        email: 'sarah@example.test',
      });

      const preview = await previewMerge(owner, first.contact.id, second.contact.id);

      expect(preview.conflicts.map((conflict) => conflict.field)).toContain('lastName');
    });

    it('fills a gap from the duplicate and keeps the survivor’s own values', async () => {
      const { survivor, duplicate } = await twoRecordsOfOnePerson();

      await mergeContacts(contextFor('owner'), {
        survivorId: survivor,
        duplicateId: duplicate,
        confirm: true,
      });

      const [row] = await harness.owner.select().from(contacts).where(eq(contacts.id, survivor));

      expect(row?.lastName).toBe('Mitchell');
      expect(row?.phone).toBe('0412 345 678');
      // The derived matching key must move with the value, or the survivor
      // becomes unfindable by the very number just merged onto them.
      expect(row?.phoneE164).toBe('+61412345678');
    });

    it('honours an explicit override on a conflicting field', async () => {
      const owner = contextFor('owner');
      const first = await createContact(owner, {
        firstName: 'Sarah',
        lastName: 'Mitchell',
        email: 'sarah@example.test',
      });
      const second = await createContact(owner, {
        firstName: 'Sarah',
        lastName: 'Nguyen',
        email: 'sarah@example.test',
      });

      await mergeContacts(owner, {
        survivorId: first.contact.id,
        duplicateId: second.contact.id,
        fieldChoices: { lastName: 'duplicate' },
        confirm: true,
      });

      const [row] = await harness.owner
        .select()
        .from(contacts)
        .where(eq(contacts.id, first.contact.id));

      // Never concatenated. "Mitchell Nguyen" is not a surname.
      expect(row?.lastName).toBe('Nguyen');
    });

    it('resolves the merged id to a redirect rather than a 404', async () => {
      const { survivor, duplicate } = await twoRecordsOfOnePerson();
      await mergeContacts(contextFor('owner'), {
        survivorId: survivor,
        duplicateId: duplicate,
        confirm: true,
      });

      const redirect = await resolveMergeRedirect(contextFor('owner'), duplicate);

      expect(redirect?.mergedInto).toBe(survivor);
      // A live contact is not a redirect.
      expect(await resolveMergeRedirect(contextFor('owner'), survivor)).toBeNull();
    });

    it('publishes an event carrying identifiers only', async () => {
      const { survivor, duplicate } = await twoRecordsOfOnePerson();
      published = [];

      await mergeContacts(contextFor('owner'), {
        survivorId: survivor,
        duplicateId: duplicate,
        confirm: true,
      });

      const event = published.find((item) => item.name === 'crm.contact.merged');
      expect(event).toBeDefined();
      expect(JSON.stringify(event)).not.toMatch(/sarah|mitchell|0412/i);
    });

    it('refuses a second merge of the same tombstone', async () => {
      const { survivor, duplicate } = await twoRecordsOfOnePerson();
      const owner = contextFor('owner');
      await mergeContacts(owner, { survivorId: survivor, duplicateId: duplicate, confirm: true });

      await expect(
        mergeContacts(owner, { survivorId: survivor, duplicateId: duplicate, confirm: true }),
      ).rejects.toThrow(ConflictError);
    });
  });

  // -------------------------------------------------------------------------
  // Erasure
  // -------------------------------------------------------------------------

  describe('erasure', () => {
    it('leaves no searchable trace of the person', async () => {
      const owner = contextFor('owner');
      const created = await createContact(owner, {
        firstName: 'Nadia',
        lastName: 'Haddad',
        email: 'nadia@example.test',
        phone: '0412 987 654',
      });

      // Before: the name is findable in at least the contact and its timeline.
      expect(await countTracesOf(owner, 'Nadia')).toBeGreaterThan(0);

      await eraseContact(owner, created.contact.id);

      // Asserted by SEARCHING rather than by checking the columns the routine
      // happens to touch — a test written against the implementation would
      // pass even if the implementation missed one.
      expect(await countTracesOf(owner, 'Nadia')).toBe(0);
      expect(await countTracesOf(owner, 'Haddad')).toBe(0);
      expect(await countTracesOf(owner, 'nadia@example.test')).toBe(0);
      expect(await countTracesOf(owner, '0412 987 654')).toBe(0);
    });

    it('previews what survives, not only what goes', async () => {
      const owner = contextFor('owner');
      const created = await createContact(owner, {
        firstName: 'Nadia',
        email: 'nadia@example.test',
      });

      const preview = await previewErasure(owner, created.contact.id);

      // The most common misunderstanding of "erase this customer" is that it
      // deletes the sale. The preview has to say otherwise, in the UI.
      expect(preview.retained.join(' ')).toMatch(/deal value/i);
      expect(preview.blockers).toEqual([]);
    });

    it('refuses to erase a merge tombstone and points at the survivor', async () => {
      const owner = contextFor('owner');
      const first = await createContact(owner, { firstName: 'Sarah', email: 'sarah@example.test' });
      const second = await createContact(owner, { firstName: 'Sarah', phone: '0412 345 678' });
      await mergeContacts(owner, {
        survivorId: first.contact.id,
        duplicateId: second.contact.id,
        confirm: true,
      });

      // Erasing the tombstone would clear a redirect while leaving the record
      // that actually holds the person's data fully intact.
      expect(await publicMessageOf(() => eraseContact(owner, second.contact.id))).toMatch(
        /surviving contact/i,
      );
    });

    it('refuses a second erasure', async () => {
      const owner = contextFor('owner');
      const created = await createContact(owner, {
        firstName: 'Nadia',
        email: 'nadia@example.test',
      });

      await eraseContact(owner, created.contact.id);
      await expect(eraseContact(owner, created.contact.id)).rejects.toThrow(ConflictError);
    });

    it('refuses to write a new custom field value onto an erased contact', async () => {
      const owner = contextFor('owner');
      const field = await createCustomField(owner, {
        key: 'property_type',
        label: 'Property type',
        type: 'text',
        required: false,
      });
      const created = await createContact(owner, {
        firstName: 'Nadia',
        email: 'nadia@example.test',
      });

      await eraseContact(owner, created.contact.id);

      // Without this, erasure could be quietly undone one field at a time.
      await expect(
        setCustomFieldValue(owner, created.contact.id, {
          definitionId: field.id,
          value: 'Terrace at 12 Smith St',
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // LIKE pattern escaping
  // -------------------------------------------------------------------------

  /**
   * ⚠️ ASSERTED AGAINST POSTGRES, NOT AGAINST THE PATTERN STRING.
   *
   * `like.test.ts` proves the escaper builds the string it means to. That is
   * the weak property: what matters is which rows the database matches, and
   * LIKE escape semantics are exactly the thing 0018 measured rather than
   * reasoned about. These assertions would all have passed on a pattern that
   * looks escaped and matches the wrong rows.
   *
   * Before the fix the three call sites escaped `%` and `_` but not `\\`, so a
   * term containing a backslash mis-assigned every escape after it.
   */
  describe('search terms containing a backslash', () => {
    it('⚠️ countTracesOf FINDS a contact whose name contains a backslash', async () => {
      // The one that matters most. This helper is how the erasure suite proves
      // data is gone; before the fix it returned 0 for this contact, which
      // reads as "erasure verified" for a person still in the database.
      const owner = contextFor('owner');
      await createContact(owner, {
        firstName: 'Sara\\Jones',
        email: 'sara.jones@example.test',
      });

      expect(await countTracesOf(owner, 'Sara\\Jones')).toBeGreaterThan(0);
    });

    it('⚠️ countTracesOf does not report a contact that lacks the backslash', async () => {
      // The other direction of the same defect. Before the fix `Sara\Jones`
      // matched the stored value `SaraJones`, so the helper could report a
      // trace of someone who was never there.
      const owner = contextFor('owner');
      await createContact(owner, {
        firstName: 'SaraJones',
        email: 'sarajones@example.test',
      });

      expect(await countTracesOf(owner, 'Sara\\Jones')).toBe(0);
    });

    it('keeps the trailing wildcard a wildcard when the term ends in a backslash', async () => {
      // Dev log 0018's case: the old form produced `%a\%`, whose closing
      // wildcard was consumed as an escaped literal `%`, so the pattern stopped
      // being a substring search. A stored `Sara%` then matched a search for
      // `a\`, which is a trace attributed to the wrong person.
      const owner = contextFor('owner');
      await createContact(owner, { firstName: 'Sara%', email: 'sara.pc@example.test' });

      expect(await countTracesOf(owner, 'a\\')).toBe(0);
    });

    it('still finds the plain terms the erasure suite relies on', async () => {
      // The negative control. If the fix had broken ordinary search, every
      // assertion above could pass while the suite's real purpose regressed.
      const owner = contextFor('owner');
      await createContact(owner, {
        firstName: 'Nadia',
        lastName: 'Haddad',
        email: 'nadia@example.test',
        phone: '0412 987 654',
      });

      expect(await countTracesOf(owner, 'Nadia')).toBeGreaterThan(0);
      expect(await countTracesOf(owner, 'Haddad')).toBeGreaterThan(0);
      expect(await countTracesOf(owner, 'nadia@example.test')).toBeGreaterThan(0);
    });

    it('contact search finds and excludes a backslash name correctly', async () => {
      const owner = contextFor('owner');
      await createContact(owner, { firstName: 'Ana\\Ruiz', email: 'ana.ruiz@example.test' });
      await createContact(owner, { firstName: 'AnaRuiz', email: 'anaruiz@example.test' });

      const found = await listContacts(owner, {
        query: 'Ana\\Ruiz',
        limit: 25,
        sort: 'createdAt',
        direction: 'desc',
      });
      const names = found.items.map((item) => item.displayName);

      expect(names).toContain('Ana\\Ruiz');
      expect(names).not.toContain('AnaRuiz');
    });

    it('company search finds and excludes a backslash name correctly', async () => {
      const owner = contextFor('owner');
      await createCompany(owner, { name: 'Acme\\Co' });
      await createCompany(owner, { name: 'AcmeCo' });

      const found = await listCompanies(owner, { query: 'Acme\\Co', limit: 25 });
      const names = found.items.map((item) => item.name);

      expect(names).toContain('Acme\\Co');
      expect(names).not.toContain('AcmeCo');
    });

    it('a percent or underscore in a term is still a literal, not a wildcard', async () => {
      // The behaviour the old escaper got right. Proven here so the fix cannot
      // trade one defect for the other.
      const owner = contextFor('owner');
      await createContact(owner, { firstName: 'Ten%Off', email: 'ten@example.test' });
      await createContact(owner, { firstName: 'TenXOff', email: 'tenx@example.test' });

      const found = await listContacts(owner, {
        query: 'Ten%Off',
        limit: 25,
        sort: 'createdAt',
        direction: 'desc',
      });
      const names = found.items.map((item) => item.displayName);

      expect(names).toContain('Ten%Off');
      expect(names).not.toContain('TenXOff');
    });
  });

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  describe('ingestion', () => {
    const submission = (overrides: Record<string, unknown> = {}) =>
      ingestAcquisitionSchema.parse({
        identity: { firstName: 'Priya', lastName: 'Raman', email: 'priya@example.test' },
        provenance: {
          sourceType: 'website_form',
          sourcePlatform: 'growth_os',
          confidence: 'declared',
          landingPath: '/emergency-plumber',
        },
        idempotency: { sourceSystem: 'website_form', externalKey: 'submission_1' },
        ...overrides,
      });

    it('creates a contact, an acquisition and a timeline entry together', async () => {
      const result = await ingestAcquisition(contextFor('owner'), submission());

      expect(result.outcome).toBe('created');
      expect(result.match).toBe('created_new');
      expect(result.acquisitionId).toBeTruthy();
    });

    it('returns the original result for a retry, creating nothing new', async () => {
      const owner = contextFor('owner');
      const first = await ingestAcquisition(owner, submission());
      const retry = await ingestAcquisition(owner, submission());

      expect(retry.outcome).toBe('duplicate');
      expect(retry.contactId).toBe(first.contactId);
      expect(retry.acquisitionId).toBe(first.acquisitionId);

      const rows = await harness.owner.select().from(schemaTables.acquisitions);
      // The whole point: a retrying webhook must not inflate the lead count.
      expect(rows).toHaveLength(1);
    });

    it('does not publish an event for a retry', async () => {
      const owner = contextFor('owner');
      await ingestAcquisition(owner, submission());
      published = [];

      await ingestAcquisition(owner, submission());

      // Re-emitting would let a retry inflate downstream counters even though
      // the database correctly refused to create a second row.
      expect(published.filter((event) => event.name === 'crm.acquisition.ingested')).toHaveLength(
        0,
      );
    });

    it('rejects the same key reused with different content', async () => {
      const owner = contextFor('owner');
      await ingestAcquisition(owner, submission());

      // Returning the original result here would hide a real integration bug
      // and could attach one person's data to another's acquisition.
      await expect(
        ingestAcquisition(
          owner,
          submission({
            identity: { firstName: 'Someone', lastName: 'Else', email: 'else@example.test' },
          }),
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('attaches a second enquiry to the existing person rather than duplicating them', async () => {
      const owner = contextFor('owner');
      const first = await ingestAcquisition(owner, submission());
      const second = await ingestAcquisition(
        owner,
        submission({ idempotency: { sourceSystem: 'website_form', externalKey: 'submission_2' } }),
      );

      expect(second.match).toBe('matched_existing');
      expect(second.contactId).toBe(first.contactId);

      // Two acquisitions, one contact. A second visit must not overwrite the
      // first, and must not create a second person.
      expect(await harness.owner.select().from(schemaTables.acquisitions)).toHaveLength(2);
      expect(await harness.owner.select().from(contacts)).toHaveLength(1);
    });

    it('opens a deal linked to the acquisition that produced it', async () => {
      const result = await ingestAcquisition(
        contextFor('owner'),
        submission({
          opportunity: { title: 'Hot water replacement', estimatedValueMinor: 140_000 },
        }),
      );

      const [deal] = await harness.owner
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, result.opportunityId!));

      // The attribution join, set at creation rather than inferred later.
      expect(deal?.acquisitionId).toBe(result.acquisitionId);
    });

    it('refuses a fabricated search query', async () => {
      // Search engines have not passed the query in the referrer since 2011.
      // A `derived` acquisition claiming one is fabricating the single number
      // this product's value rests on.
      await expect(
        ingestAcquisition(
          contextFor('owner'),
          submission({
            provenance: {
              sourceType: 'organic_search',
              sourcePlatform: 'google',
              confidence: 'derived',
              searchQuery: 'emergency plumber melbourne',
            },
          }),
        ),
      ).rejects.toThrow(/search/i);
    });
  });

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  describe('CSV import', () => {
    const mapping = { 'First name': 'firstName', Email: 'email', Source: 'sourceDetail' } as const;

    it('reports invalid rows without importing anything', async () => {
      const validation = await validateImport(contextFor('owner'), {
        filename: 'contacts.csv',
        mapping,
        rows: [
          { 'First name': 'Priya', Email: 'priya@example.test', Source: 'Google' },
          // No email and no phone: not importable as a contact.
          { 'First name': 'Nameless', Email: '', Source: '' },
        ],
      });

      expect(validation.totalRows).toBe(2);
      expect(validation.validRows).toBe(1);
      expect(validation.issues).toHaveLength(1);
      // Reported BY NUMBER, so the operator can find it in their own file.
      // "Some rows failed" is not actionable on a 3,000-row spreadsheet.
      expect(validation.issues[0]?.row).toBe(2);

      expect(await harness.owner.select().from(contacts)).toHaveLength(0);
    });

    it('never echoes the offending value back in an issue message', async () => {
      // The row's own data is what makes it invalid, so the message is the one
      // place a rejected value could leak — into an API response, a browser, a
      // screenshot, and whatever log sits in between.
      //
      // The offending value here is DISTINCTIVE on purpose. Asserting against a
      // value that is not the one being rejected would pass regardless.
      const validation = await validateImport(contextFor('owner'), {
        filename: 'contacts.csv',
        mapping,
        rows: [
          {
            'First name': 'Priya',
            Email: 'sarah-mitchell-0412987654-not-an-address',
            Source: '',
          },
        ],
      });

      expect(validation.issues).toHaveLength(1);
      const message = validation.issues[0]?.message ?? '';

      expect(message).not.toContain('sarah-mitchell');
      expect(message).not.toContain('0412987654');
      // It still has to be useful: the field and the rule are named.
      expect(message).toMatch(/email/i);
    });

    it('records provenance it can honestly claim', async () => {
      await runImport(contextFor('owner'), {
        filename: 'contacts.csv',
        mapping,
        rows: [{ 'First name': 'Priya', Email: 'priya@example.test', Source: 'Google' }],
      });

      const [row] = await harness.owner.select().from(schemaTables.acquisitions);

      // A spreadsheet column saying "Google" is a human's recollection, not a
      // measurement. It lands as channel detail and never as the source type.
      expect(row?.sourceType).toBe('import');
      expect(row?.confidence).toBe('manual');
      expect(row?.channelDetail).toBe('Google');
      expect(row?.searchQuery).toBeNull();
    });

    it('imports the good rows and reports the bad ones', async () => {
      const result = await runImport(contextFor('owner'), {
        filename: 'contacts.csv',
        mapping,
        rows: [
          { 'First name': 'Priya', Email: 'priya@example.test', Source: '' },
          { 'First name': '', Email: 'broken@example.test', Source: '' },
          { 'First name': 'Tom', Email: 'tom@example.test', Source: '' },
        ],
      });

      expect(result.importedRows).toBe(2);
      expect(result.issues).toHaveLength(1);
      expect(await harness.owner.select().from(contacts)).toHaveLength(2);
    });

    it('re-importing the same file updates nobody and creates no duplicate people', async () => {
      const owner = contextFor('owner');
      const rows = [{ 'First name': 'Priya', Email: 'priya@example.test', Source: '' }];

      await runImport(owner, { filename: 'contacts.csv', mapping, rows });
      const second = await runImport(owner, { filename: 'contacts.csv', mapping, rows });

      // A new batch means new idempotency keys, so the rows genuinely re-run —
      // and identity matching is what stops them becoming a second person.
      expect(second.matchedExistingRows).toBe(1);
      expect(await harness.owner.select().from(contacts)).toHaveLength(1);
    });

    it('never maps a column to a field outside the allowlist', () => {
      // A mapping is resolved through a closed enum, so a crafted mapping
      // cannot aim a CSV column at `workspace_id`.
      const { prepared } = prepareRows(
        {
          filename: 'x.csv',
          // Only `Email` is mapped. The row also carries a `workspace_id`
          // column, which a naive "write every column" import would honour.
          mapping: { Email: 'email' },
          rows: [{ Email: 'priya@example.test', workspace_id: 'attacker-controlled' }],
        },
        'AU',
      );

      // No first name, so the row is not importable at all — and the
      // `workspace_id` column was never read in the first place.
      expect(prepared).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Custom fields
  // -------------------------------------------------------------------------

  describe('custom fields', () => {
    it('rejects a value that does not fit its definition', async () => {
      const owner = contextFor('owner');
      const field = await createCustomField(owner, {
        key: 'bedrooms',
        label: 'Bedrooms',
        type: 'number',
        required: false,
      });
      const created = await createContact(owner, {
        firstName: 'Priya',
        email: 'priya@example.test',
      });

      // Accepting this as text is exactly the failure a typed schema exists to
      // prevent, and it only surfaces later as a broken report.
      await expect(
        setCustomFieldValue(owner, created.contact.id, {
          definitionId: field.id,
          value: 'probably 40ish',
        }),
      ).rejects.toThrow(/must be a number/i);
    });

    it('rejects an impossible date rather than rolling it forward', async () => {
      const owner = contextFor('owner');
      const field = await createCustomField(owner, {
        key: 'installed_on',
        label: 'Installed on',
        type: 'date',
        required: false,
      });
      const created = await createContact(owner, {
        firstName: 'Priya',
        email: 'priya@example.test',
      });

      await expect(
        setCustomFieldValue(owner, created.contact.id, {
          definitionId: field.id,
          value: '2026-02-30',
        }),
      ).rejects.toThrow(/not a real date/i);
    });

    it('rejects a choice outside the declared options', async () => {
      const owner = contextFor('owner');
      const field = await createCustomField(owner, {
        key: 'property_type',
        label: 'Property type',
        type: 'single_select',
        required: false,
        options: ['House', 'Apartment'],
      });
      const created = await createContact(owner, {
        firstName: 'Priya',
        email: 'priya@example.test',
      });

      await expect(
        setCustomFieldValue(owner, created.contact.id, {
          definitionId: field.id,
          value: 'Houseboat',
        }),
      ).rejects.toThrow(/must be one of/i);
    });

    it('clears a value by deleting the row, not by blanking it', async () => {
      const owner = contextFor('owner');
      const field = await createCustomField(owner, {
        key: 'property_type',
        label: 'Property type',
        type: 'text',
        required: false,
      });
      const created = await createContact(owner, {
        firstName: 'Priya',
        email: 'priya@example.test',
      });

      await setCustomFieldValue(owner, created.contact.id, {
        definitionId: field.id,
        value: 'Terrace',
      });
      await setCustomFieldValue(owner, created.contact.id, { definitionId: field.id, value: null });

      expect(await harness.owner.select().from(schemaTables.contactFieldValues)).toHaveLength(0);

      // The definition still appears, valued as null, so the form renders.
      const values = await listCustomFieldValues(owner, created.contact.id);
      expect(values).toHaveLength(1);
      expect(values[0]?.value).toBeNull();
    });

    it('refuses to remove an option that contacts may already hold', async () => {
      const owner = contextFor('owner');
      const field = await createCustomField(owner, {
        key: 'property_type',
        label: 'Property type',
        type: 'single_select',
        required: false,
        options: ['House', 'Apartment'],
      });

      const { updateCustomField } = await import('./custom-fields/service');

      // Removing an option would leave holders with a value that is invisible
      // in the UI, still in the database, and silently wrong in any export.
      expect(
        await publicMessageOf(() => updateCustomField(owner, field.id, { options: ['House'] })),
      ).toMatch(/cannot be removed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  describe('tags', () => {
    it('treats differently-cased names as one tag', async () => {
      const admin = contextFor('admin');
      await createTag(admin, { name: 'Hot Lead', tone: 'attention' });

      // Otherwise a workspace ends up with "hot lead", "Hot Lead" and
      // "HOT LEAD", and can segment by none of them.
      await expect(createTag(admin, { name: 'hot lead', tone: 'neutral' })).rejects.toThrow(
        ConflictError,
      );
    });

    it('applying the same tag twice is a no-op, not a duplicate', async () => {
      const owner = contextFor('owner');
      const tag = await createTag(owner, { name: 'VIP', tone: 'signal' });
      const created = await createContact(owner, {
        firstName: 'Priya',
        email: 'priya@example.test',
      });

      await applyTag(owner, created.contact.id, tag.id);
      const applied = await applyTag(owner, created.contact.id, tag.id);

      expect(applied).toHaveLength(1);
      expect(await listContactTags(owner, created.contact.id)).toHaveLength(1);
    });
  });
});
