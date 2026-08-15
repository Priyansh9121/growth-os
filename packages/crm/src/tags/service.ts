/**
 * Tag service — the workspace's own vocabulary for segmenting contacts.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Tags are ROWS, not free text on the contact. That distinction buys three
 * things a text column cannot: renaming "vip" to "VIP client" is one UPDATE
 * rather than a rewrite of every contact; "which contacts are tagged X?" is an
 * index lookup rather than a string scan; and the set of tags in use is
 * knowable, so the UI can offer them instead of inviting typos.
 *
 * TWO CAPABILITIES, NOT ONE
 * Applying an existing tag is daily work (`tags:apply`, held by `member`).
 * Defining the vocabulary is not (`tags:manage`, admin and owner). Without the
 * split, every operator could invent tags, and a workspace ends up with
 * "urgent", "Urgent", "URGENT!" and no way to segment by any of them.
 *
 * @see docs/decisions/ADR-0013-soft-deletion-and-retention.md — archive, never delete
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ACTIVITY_TYPES,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ContactTagView,
  type CreateTagInput,
  type TagView,
  type UpdateTagInput,
} from '@growth-os/contracts';
import { schemaTables } from '@growth-os/database';
import {
  actorUserId,
  contextNow,
  inTenant,
  loadInTenant,
  requireCapability,
  tenantScope,
  type CrmContext,
} from '../shared/context';
import { recordActivity } from '../activities/service';

const { contactTags, contacts, tags } = schemaTables;

/**
 * The matching key for a tag name.
 *
 * Lowercased with internal whitespace collapsed, so "Hot Lead", "hot lead" and
 * "hot  lead" are one tag rather than three. Punctuation is preserved: "B2B"
 * and "B-2-B" are plausibly different labels and merging them would be a guess.
 */
export function tagSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function listTags(context: CrmContext, includeArchived = false): Promise<TagView[]> {
  requireCapability(context, 'workspace:crm:contacts:read');

  return inTenant(context, async (tx, workspace) => {
    const conditions = [tenantScope(tags, workspace)];
    if (!includeArchived) conditions.push(isNull(tags.archivedAt));

    const rows = await tx
      .select({
        id: tags.id,
        name: tags.name,
        slug: tags.slug,
        tone: tags.tone,
        archivedAt: tags.archivedAt,
        // Counted in the same query rather than N+1 per tag. Tag lists are
        // small, but this is also the screen that answers "is this tag worth
        // keeping?", so the number has to be there.
        contactCount: sql<number>`(
          select count(*)::int from ${contactTags}
           where ${contactTags.tagId} = ${tags.id})`,
      })
      .from(tags)
      .where(and(...conditions))
      .orderBy(asc(tags.name));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      tone: row.tone,
      contactCount: row.contactCount,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    }));
  });
}

export async function createTag(context: CrmContext, input: CreateTagInput): Promise<TagView> {
  requireCapability(context, 'workspace:crm:tags:manage');

  const slug = tagSlug(input.name);
  if (slug.length === 0) throw new ValidationError('A tag needs a name.');

  return inTenant(context, async (tx, workspace) => {
    const [existing] = await tx
      .select({ id: tags.id, archivedAt: tags.archivedAt })
      .from(tags)
      .where(and(tenantScope(tags, workspace), eq(tags.slug, slug)))
      .limit(1);

    if (existing) {
      // Re-creating a tag whose name matches an ARCHIVED one restores it
      // rather than failing. The operator's intent — "I want this tag" — is
      // unambiguous, and refusing would leave them with no way to get it back
      // except inventing a slightly different name.
      if (existing.archivedAt !== null) {
        await tx
          .update(tags)
          .set({
            archivedAt: null,
            name: input.name,
            tone: input.tone,
            updatedAt: contextNow(context),
          })
          .where(and(eq(tags.id, existing.id), tenantScope(tags, workspace)));
        return projectTag(tx, workspace, existing.id);
      }

      throw new ConflictError(
        `Tag ${slug} already exists in workspace ${workspace}`,
        'A tag with that name already exists.',
      );
    }

    const now = contextNow(context);
    const [row] = await tx
      .insert(tags)
      .values({
        workspaceId: workspace,
        name: input.name,
        slug,
        tone: input.tone,
        createdByUserId: actorUserId(context),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tags.id });

    if (!row) throw new Error('Failed to insert tag');
    return projectTag(tx, workspace, row.id);
  });
}

export async function updateTag(
  context: CrmContext,
  tagId: string,
  input: UpdateTagInput,
): Promise<TagView> {
  requireCapability(context, 'workspace:crm:tags:manage');

  return inTenant(context, async (tx, workspace) => {
    await loadInTenant(tx, tags, workspace, tagId);
    const now = contextNow(context);

    const changes: Record<string, unknown> = { updatedAt: now };
    if (input.name !== undefined) {
      const slug = tagSlug(input.name);
      const [clash] = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(tenantScope(tags, workspace), eq(tags.slug, slug), sql`${tags.id} <> ${tagId}`))
        .limit(1);
      if (clash) {
        throw new ConflictError(
          `Tag slug ${slug} is taken in workspace ${workspace}`,
          'Another tag already uses that name.',
        );
      }
      changes['name'] = input.name;
      changes['slug'] = slug;
    }
    if (input.tone !== undefined) changes['tone'] = input.tone;
    // Archive rather than delete: deleting a tag would silently untag every
    // contact that carried it, with no record it ever existed (ADR-0013).
    if (input.archived !== undefined) changes['archivedAt'] = input.archived ? now : null;

    await tx
      .update(tags)
      .set(changes)
      .where(and(eq(tags.id, tagId), tenantScope(tags, workspace)));

    return projectTag(tx, workspace, tagId);
  });
}

export async function applyTag(
  context: CrmContext,
  contactId: string,
  tagId: string,
): Promise<readonly ContactTagView[]> {
  requireCapability(context, 'workspace:crm:tags:apply');

  return inTenant(context, async (tx, workspace) => {
    // Tenant-scoped existence check. Tagging a merged tombstone or an
    // archived record would create an assignment nothing ever displays.
    await loadInTenant(tx, contacts, workspace, contactId, [
      isNull(contacts.deletedAt),
      isNull(contacts.mergedAt),
    ]);
    const tag = await loadInTenant(tx, tags, workspace, tagId, [isNull(tags.archivedAt)]);

    const now = contextNow(context);

    // ON CONFLICT DO NOTHING rather than a read-then-write: two operators
    // clicking the same tag at the same moment must produce one row, and a
    // check-then-insert races.
    const inserted = await tx
      .insert(contactTags)
      .values({
        workspaceId: workspace,
        contactId,
        tagId,
        taggedByUserId: actorUserId(context),
        createdAt: now,
      })
      .onConflictDoNothing({ target: [contactTags.contactId, contactTags.tagId] })
      .returning({ id: contactTags.id });

    // Only record a timeline entry when something actually changed. A
    // re-applied tag that produced a fresh entry every click would fill the
    // customer's history with noise.
    if (inserted.length > 0) {
      await recordActivity(context, tx, {
        type: ACTIVITY_TYPES.CONTACT_TAGGED,
        summary: `Tagged ${tag.name}`,
        contactId,
        occurredAt: now,
      });
    }

    return contactTagsFor(tx, workspace, contactId);
  });
}

export async function removeTag(
  context: CrmContext,
  contactId: string,
  tagId: string,
): Promise<readonly ContactTagView[]> {
  requireCapability(context, 'workspace:crm:tags:apply');

  return inTenant(context, async (tx, workspace) => {
    const tag = await loadInTenant(tx, tags, workspace, tagId);

    const removed = await tx
      .delete(contactTags)
      .where(
        and(
          tenantScope(contactTags, workspace),
          eq(contactTags.contactId, contactId),
          eq(contactTags.tagId, tagId),
        ),
      )
      .returning({ id: contactTags.id });

    if (removed.length > 0) {
      await recordActivity(context, tx, {
        type: ACTIVITY_TYPES.CONTACT_UNTAGGED,
        summary: `Removed tag ${tag.name}`,
        contactId,
        occurredAt: contextNow(context),
      });
    }

    return contactTagsFor(tx, workspace, contactId);
  });
}

export async function listContactTags(
  context: CrmContext,
  contactId: string,
): Promise<readonly ContactTagView[]> {
  requireCapability(context, 'workspace:crm:contacts:read');
  return inTenant(context, (tx, workspace) => contactTagsFor(tx, workspace, contactId));
}

/**
 * Tags for a batch of contacts, for the list view.
 *
 * One query for the whole page rather than one per row — a contacts list of 50
 * would otherwise issue 50 extra round trips to render a few coloured chips.
 */
export async function tagsForContacts(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  contactIds: readonly string[],
): Promise<Map<string, ContactTagView[]>> {
  const result = new Map<string, ContactTagView[]>();
  if (contactIds.length === 0) return result;

  const rows = await tx
    .select({
      contactId: contactTags.contactId,
      id: tags.id,
      name: tags.name,
      tone: tags.tone,
    })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    // `inArray`, never a hand-built `= any(array[...])`: interpolating ids
    // into raw SQL is how an injection gets introduced by someone who "knew"
    // the values were safe. Drizzle binds them as parameters.
    .where(
      and(tenantScope(contactTags, workspace), inArray(contactTags.contactId, [...contactIds])),
    )
    .orderBy(asc(tags.name));

  for (const row of rows) {
    const list = result.get(row.contactId) ?? [];
    list.push({ id: row.id, name: row.name, tone: row.tone });
    result.set(row.contactId, list);
  }
  return result;
}

async function contactTagsFor(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  contactId: string,
): Promise<ContactTagView[]> {
  const rows = await tx
    .select({ id: tags.id, name: tags.name, tone: tags.tone })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(and(tenantScope(contactTags, workspace), eq(contactTags.contactId, contactId)))
    .orderBy(asc(tags.name));

  return rows.map((row) => ({ id: row.id, name: row.name, tone: row.tone }));
}

async function projectTag(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  workspace: string,
  tagId: string,
): Promise<TagView> {
  const [row] = await tx
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      tone: tags.tone,
      archivedAt: tags.archivedAt,
      contactCount: sql<number>`(
        select count(*)::int from ${contactTags} where ${contactTags.tagId} = ${tags.id})`,
    })
    .from(tags)
    .where(and(eq(tags.id, tagId), tenantScope(tags, workspace)))
    .limit(1);

  if (!row) throw new NotFoundError(`Tag ${tagId} not found`);

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tone: row.tone,
    contactCount: row.contactCount,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
