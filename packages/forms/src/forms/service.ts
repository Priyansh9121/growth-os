/**
 * Form administration.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Creating, configuring, publishing and pausing the forms an anonymous visitor
 * submits against.
 *
 * EDITING A FORM WRITES A NEW VERSION
 * Never mutates one. `form_versions` has no UPDATE policy — the absence is the
 * enforcement, the same mechanism that makes `activities` append-only — so a
 * lead captured under version 3 keeps meaning what it meant, and "what did this
 * form look like when that lead arrived?" stays answerable.
 *
 * A DRAFT ACCEPTS NOTHING, BY CONSTRUCTION
 * `published_version_id` is NULL until a form is deliberately published, and
 * `resolve_public_form` INNER JOINs it. A form that has never been published
 * therefore resolves to nothing at the database, not because a status check
 * somewhere remembered to run.
 *
 * @see docs/decisions/ADR-0026-public-form-resolution.md
 */

import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  ConflictError,
  formVersionConfigSchema,
  ValidationError,
  type CreateFormInput,
  type FormDetailView,
  type FormFieldConfig,
  type FormSummaryView,
  type UpdateFormInput,
} from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import {
  actorUserId,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type FormsContext,
} from '../shared/context';

const { formSubmissions, formVersions, forms, sites } = schemaTables;

type Tx = Parameters<Parameters<typeof inTenant>[1]>[0];

/**
 * Mint a public form key.
 *
 * 16 bytes → 32 hex characters → 128 bits. Enumeration is not a threat model
 * at that width, and the database enforces the shape with a CHECK constraint so
 * a future code path cannot produce a weaker one unnoticed.
 */
export function generatePublicKey(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The starting configuration for a new form.
 *
 * Name, email, phone and message — the shape of essentially every small
 * business enquiry form. Email is required because ingestion needs an email or
 * a phone to match on, and requiring one of the two at publish time is easier
 * to explain than discovering it at the first submission.
 */
function defaultConfig(): { fields: FormFieldConfig[]; settings: unknown } {
  return formVersionConfigSchema.parse({
    fields: [
      { key: 'first_name', type: 'text', label: 'First name', required: true, target: 'firstName' },
      { key: 'last_name', type: 'text', label: 'Last name', target: 'lastName' },
      { key: 'email', type: 'email', label: 'Email', required: true, target: 'email' },
      { key: 'phone', type: 'phone', label: 'Phone', target: 'phone' },
      {
        key: 'message',
        type: 'textarea',
        label: 'How can we help?',
        target: 'note',
        maxLength: 1000,
      },
    ],
    settings: {},
  }) as { fields: FormFieldConfig[]; settings: unknown };
}

/**
 * A published form must be able to identify the people who submit it.
 *
 * Checked at PUBLISH rather than at submission: a form that cannot produce a
 * usable contact should never go live, and finding that out from a lost
 * enquiry is the expensive way to learn it.
 */
export function assertPublishable(fields: readonly FormFieldConfig[]): void {
  const targets = new Set(fields.map((field) => field.target));

  if (!targets.has('email') && !targets.has('phone')) {
    throw new ValidationError(
      'A live form needs a field mapped to Email or Phone — otherwise a submission cannot be matched to a person.',
    );
  }

  if (!targets.has('firstName')) {
    throw new ValidationError('A live form needs a field mapped to First name.');
  }

  // Two inputs writing one single-value CRM property means whichever runs last
  // wins, which is a silent data-loss bug rather than a validation error.
  const singleValue = fields
    .map((field) => field.target)
    .filter((target) => target !== 'none' && target !== 'note');
  const duplicate = singleValue.find((target, index) => singleValue.indexOf(target) !== index);
  if (duplicate) {
    throw new ValidationError(
      `Two fields are both mapped to ${duplicate}. Only one field can fill each contact detail.`,
    );
  }

  const keys = fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) {
    throw new ValidationError('Two fields share the same key.');
  }
}

export async function createForm(
  context: FormsContext,
  input: CreateFormInput,
): Promise<FormDetailView> {
  requireCapability(context, 'workspace:forms:manage');

  return inTenant(context, async (tx, workspace) => {
    if (input.siteId) {
      // Verify the site is ours before linking, so a caller cannot attach a
      // form to another tenant's web property.
      await loadInTenant(tx, sites, workspace, input.siteId);
    }

    const now = contextNow(context);
    const [form] = await tx
      .insert(forms)
      .values({
        workspaceId: workspace,
        name: input.name,
        publicKey: generatePublicKey(),
        status: 'draft',
        siteId: input.siteId ?? null,
        createdByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: forms.id });

    if (!form) throw new Error('Failed to create form');

    // A version exists from the start, so the editor always has something to
    // render. It is NOT published — `published_version_id` stays NULL until
    // someone deliberately publishes.
    const config = defaultConfig();
    await tx.insert(formVersions).values({
      workspaceId: workspace,
      formId: form.id,
      version: 1,
      fields: config.fields,
      settings: config.settings as never,
      createdByUserId: actorUserId(context),
      createdAt: now,
    });

    return projectForm(tx, workspace, form.id);
  });
}

export async function updateForm(
  context: FormsContext,
  formId: string,
  input: UpdateFormInput,
): Promise<FormDetailView> {
  requireCapability(context, 'workspace:forms:manage');

  return inTenant(context, async (tx, workspace) => {
    const existing = await loadInTenant(tx, forms, workspace, formId, [isNull(forms.archivedAt)]);
    const now = contextNow(context);

    if (input.siteId) await loadInTenant(tx, sites, workspace, input.siteId);

    let versionId = existing.publishedVersionId;

    if (input.config) {
      // A NEW VERSION, always. Never an update.
      const parsed = formVersionConfigSchema.parse(input.config);
      const [latest] = await tx
        .select({ version: formVersions.version })
        .from(formVersions)
        .where(and(tenantScope(formVersions, workspace), eq(formVersions.formId, formId)))
        .orderBy(desc(formVersions.version))
        .limit(1);

      const [created] = await tx
        .insert(formVersions)
        .values({
          workspaceId: workspace,
          formId,
          version: (latest?.version ?? 0) + 1,
          fields: parsed.fields,
          settings: parsed.settings,
          createdByUserId: actorUserId(context),
          createdAt: now,
        })
        .returning({ id: formVersions.id });

      if (!created) throw new Error('Failed to create form version');

      // A LIVE form republishes immediately; a draft does not, so editing a
      // draft cannot accidentally put it in front of the public.
      if (existing.status === 'active') {
        assertPublishable(parsed.fields);
        versionId = created.id;
      }
    }

    const status = input.status ?? existing.status;

    if (status === 'active' && input.status === 'active') {
      // Publishing: take the newest version, having checked it can identify a
      // person.
      const [newest] = await tx
        .select({ id: formVersions.id, fields: formVersions.fields })
        .from(formVersions)
        .where(and(tenantScope(formVersions, workspace), eq(formVersions.formId, formId)))
        .orderBy(desc(formVersions.version))
        .limit(1);

      if (!newest)
        throw new ConflictError('Form has no version', 'This form has no configuration.');
      assertPublishable(formVersionConfigSchema.shape.fields.parse(newest.fields));
      versionId = newest.id;
    }

    const changes: Record<string, unknown> = { updatedAt: now, status };
    if (input.name !== undefined) changes['name'] = input.name;
    if (input.siteId !== undefined) changes['siteId'] = input.siteId;
    if (versionId !== existing.publishedVersionId) changes['publishedVersionId'] = versionId;

    await tx
      .update(forms)
      .set(changes)
      .where(and(eq(forms.id, formId), tenantScope(forms, workspace)));

    return projectForm(tx, workspace, formId);
  });
}

/**
 * Rotate a form's public key.
 *
 * The remedy when a key is abused. It BREAKS EVERY EXISTING EMBED — which is
 * the point, and is stated in the UI before the operator confirms.
 */
export async function rotatePublicKey(
  context: FormsContext,
  formId: string,
): Promise<FormDetailView> {
  requireCapability(context, 'workspace:forms:manage');

  return inTenant(context, async (tx, workspace) => {
    await loadInTenant(tx, forms, workspace, formId);
    await tx
      .update(forms)
      .set({ publicKey: generatePublicKey(), updatedAt: contextNow(context) })
      .where(and(eq(forms.id, formId), tenantScope(forms, workspace)));
    return projectForm(tx, workspace, formId);
  });
}

export async function listForms(context: FormsContext): Promise<readonly FormSummaryView[]> {
  requireCapability(context, 'workspace:forms:read');

  return inTenant(context, async (tx, workspace) => {
    const rows = await tx
      .select({
        id: forms.id,
        name: forms.name,
        publicKey: forms.publicKey,
        status: forms.status,
        siteId: forms.siteId,
        siteOrigin: sites.origin,
        createdAt: forms.createdAt,
        version: formVersions.version,
        // Counted in the same query. A forms list with a submission count is
        // the screen that answers "is this working?", so the number has to be
        // there rather than behind a click.
        submissionCount: sql<number>`(
          select count(*)::int from ${formSubmissions}
           where ${formSubmissions.formId} = ${forms.id})`,
        leadCount: sql<number>`(
          select count(*)::int from ${formSubmissions}
           where ${formSubmissions.formId} = ${forms.id}
             and ${formSubmissions.outcome} = 'created')`,
        lastSubmissionAt: sql<Date | null>`(
          select max(${formSubmissions.createdAt}) from ${formSubmissions}
           where ${formSubmissions.formId} = ${forms.id})`,
      })
      .from(forms)
      .leftJoin(sites, eq(sites.id, forms.siteId))
      .leftJoin(formVersions, eq(formVersions.id, forms.publishedVersionId))
      .where(and(tenantScope(forms, workspace), isNull(forms.archivedAt)))
      .orderBy(desc(forms.createdAt));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      publicKey: row.publicKey,
      status: row.status,
      version: row.version,
      siteId: row.siteId,
      siteOrigin: row.siteOrigin,
      submissionCount: row.submissionCount,
      leadCount: row.leadCount,
      lastSubmissionAt: row.lastSubmissionAt ? new Date(row.lastSubmissionAt).toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

export async function getForm(context: FormsContext, formId: string): Promise<FormDetailView> {
  requireCapability(context, 'workspace:forms:read');
  return inTenant(context, (tx, workspace) => projectForm(tx, workspace, formId));
}

async function projectForm(tx: Tx, workspace: string, formId: string): Promise<FormDetailView> {
  const form = await loadInTenant(tx, forms, workspace, formId);

  const versions = await tx
    .select({
      id: formVersions.id,
      version: formVersions.version,
      fields: formVersions.fields,
      settings: formVersions.settings,
      createdAt: formVersions.createdAt,
    })
    .from(formVersions)
    .where(and(tenantScope(formVersions, workspace), eq(formVersions.formId, formId)))
    .orderBy(desc(formVersions.version));

  // The editor shows the NEWEST version, which may be ahead of the published
  // one — that is the draft an operator is working on.
  const newest = versions[0];
  const published = versions.find((version) => version.id === form.publishedVersionId);

  const [counts] = await tx
    .select({
      submissionCount: sql<number>`count(*)::int`,
      leadCount: sql<number>`count(*) filter (where ${formSubmissions.outcome} = 'created')::int`,
      lastSubmissionAt: sql<Date | null>`max(${formSubmissions.createdAt})`,
    })
    .from(formSubmissions)
    .where(and(tenantScope(formSubmissions, workspace), eq(formSubmissions.formId, formId)));

  const [site] = form.siteId
    ? await tx
        .select({ origin: sites.origin })
        .from(sites)
        .where(and(eq(sites.id, form.siteId), tenantScope(sites, workspace)))
        .limit(1)
    : [];

  return {
    id: form.id,
    name: form.name,
    publicKey: form.publicKey,
    status: form.status,
    version: published?.version ?? null,
    siteId: form.siteId,
    siteOrigin: site?.origin ?? null,
    submissionCount: counts?.submissionCount ?? 0,
    leadCount: counts?.leadCount ?? 0,
    lastSubmissionAt: counts?.lastSubmissionAt
      ? new Date(counts.lastSubmissionAt).toISOString()
      : null,
    createdAt: form.createdAt.toISOString(),
    config: newest
      ? formVersionConfigSchema.parse({ fields: newest.fields, settings: newest.settings })
      : null,
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      createdAt: version.createdAt.toISOString(),
    })),
  };
}
