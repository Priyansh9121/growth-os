/**
 * Workspace invitations.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The only way a second person gains access to a workspace. Growth OS is
 * invitation-only in Stage 2 — there is deliberately no public registration
 * endpoint (ADR-0018).
 *
 * SECURITY PROPERTIES, AND WHY EACH EXISTS
 *  - 32-byte token, stored ONLY as `SHA-256(HMAC(token, secret))`. Identical
 *    construction to sessions: a read-only database leak yields no usable
 *    invitations to any pending workspace.
 *  - 7-day expiry. Bounds the window if a link is forwarded or leaks from an
 *    inbox.
 *  - Single use, marked inside the accepting transaction — so a forwarded link
 *    cannot create a second membership.
 *  - **An inviter cannot grant a role stronger than their own.** Without this,
 *    `members:invite` is a silent privilege-escalation path to workspace
 *    ownership.
 *  - Enumeration-safe lookup: invalid, expired, revoked and already-accepted
 *    tokens are indistinguishable to the caller.
 *
 * @see docs/decisions/ADR-0018-invitations-and-registration.md
 */

import { and, eq, isNull } from 'drizzle-orm';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  strongerWorkspaceRole,
  WORKSPACE_ROLE_RANK,
  type TenantActor,
  type WorkspaceRole,
} from '@growth-os/contracts';
import {
  AUDIT_EVENTS,
  schemaTables,
  withTenantTransaction,
  writeAuditEvent,
  type Database,
} from '@growth-os/database';

const { invitations, memberships, users } = schemaTables;

/** 7 days. Long enough for a real person; short enough to bound a leaked link. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Derive the stored token hash.
 *
 * Same construction as session tokens: HMAC binds the value to the
 * application secret, so database contents alone are not usable.
 */
function hashInvitationToken(token: string, secret: string): string {
  return createHash('sha256')
    .update(createHmac('sha256', secret).update(token).digest())
    .digest('hex');
}

export interface CreateInvitationInput {
  readonly email: string;
  readonly role: WorkspaceRole;
}

export interface CreatedInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly expiresAt: Date;
  /**
   * The raw token. Exists ONLY here — never persisted, never recoverable.
   * Deliver it and discard it.
   */
  readonly token: string;
}

/**
 * Invite someone to a workspace.
 *
 * @throws AuthorizationError when the caller lacks `members:invite`, or when
 *   they attempt to grant a role stronger than their own.
 * @throws ConflictError when the person is already a member.
 */
export async function createInvitation(
  db: Database,
  tenant: TenantActor,
  input: CreateInvitationInput,
  secret: string,
  correlationId?: string | undefined,
): Promise<CreatedInvitation> {
  const { workspaceRoleHasCapability } = await import('@growth-os/contracts');

  if (!workspaceRoleHasCapability(tenant.workspace.role, 'workspace:members:invite')) {
    throw new AuthorizationError(`User ${tenant.actor.userId} lacks workspace:members:invite`, {
      details: { workspaceId: tenant.workspace.workspaceId },
    });
  }

  // PRIVILEGE ESCALATION DEFENCE. An admin inviting an owner would hand
  // themselves ownership by proxy, so the granted role is capped at the
  // inviter's own rank.
  if (WORKSPACE_ROLE_RANK[input.role] > WORKSPACE_ROLE_RANK[tenant.workspace.role]) {
    throw new AuthorizationError(
      `User ${tenant.actor.userId} (${tenant.workspace.role}) attempted to grant ${input.role}`,
      {
        details: {
          inviterRole: tenant.workspace.role,
          attemptedRole: input.role,
          reason: 'privilege_escalation',
        },
      },
    );
  }

  const emailNormalised = input.email.trim().toLowerCase();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await withTenantTransaction(db, tenant.workspace.workspaceId, async (tx) => {
    // Already a member? Inviting them again would create a second membership
    // and an ambiguous role.
    const [existingMember] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, tenant.workspace.workspaceId),
          eq(users.email, emailNormalised),
        ),
      )
      .limit(1);

    if (existingMember) {
      throw new ConflictError(
        `${emailNormalised} is already a member of ${tenant.workspace.workspaceId}`,
        'That person is already a member of this workspace.',
      );
    }

    const [row] = await tx
      .insert(invitations)
      .values({
        workspaceId: tenant.workspace.workspaceId,
        emailNormalised,
        role: input.role,
        tokenHash: hashInvitationToken(token, secret),
        invitedByUserId: tenant.actor.userId,
        expiresAt,
      })
      .returning({ id: invitations.id });

    if (!row) throw new Error('Failed to create invitation');
    return row;
  });

  await writeAuditEvent(db, {
    workspaceId: tenant.workspace.workspaceId,
    actorUserId: tenant.actor.userId,
    eventName: AUDIT_EVENTS.CRM_INVITATION_CREATED,
    accessPath: tenant.workspace.via,
    targetType: 'invitation',
    targetId: invitation.id,
    correlationId,
    // The invited address is NOT recorded: an audit table full of email
    // addresses is itself a sensitive dataset, and the invitation row already
    // holds it under RLS.
    metadata: { role: input.role },
  });

  return { id: invitation.id, email: emailNormalised, role: input.role, expiresAt, token };
}

export interface InvitationPreview {
  readonly workspaceName: string;
  readonly role: WorkspaceRole;
  readonly email: string;
}

/**
 * Look up an invitation by raw token.
 *
 * Returns `null` for EVERY failure — unknown, expired, revoked, already
 * accepted. The caller cannot distinguish them, which is what stops this
 * endpoint confirming that a given workspace exists or that an address was
 * invited to it.
 *
 * Runs unscoped by necessity: the token is presented by someone who is not yet
 * a member, so there is no tenant context to scope by. The token itself is the
 * only authorisation, which is why it carries 256 bits of entropy.
 */
export async function findInvitationByToken(
  db: Database,
  token: string,
  secret: string,
): Promise<{
  id: string;
  workspaceId: string;
  role: WorkspaceRole;
  emailNormalised: string;
} | null> {
  const [row] = await db
    .select({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
      role: invitations.role,
      emailNormalised: invitations.emailNormalised,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .where(eq(invitations.tokenHash, hashInvitationToken(token, secret)))
    .limit(1);

  if (!row) return null;
  if (row.acceptedAt !== null || row.revokedAt !== null) return null;
  if (row.expiresAt <= new Date()) return null;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    role: row.role as WorkspaceRole,
    emailNormalised: row.emailNormalised,
  };
}

/**
 * Accept an invitation, creating the membership.
 *
 * The acceptance and the single-use marking happen in ONE transaction, with
 * the `accepted_at IS NULL` predicate in the UPDATE — so two simultaneous
 * acceptances of the same token produce exactly one membership.
 *
 * @throws NotFoundError when the token is invalid, expired, revoked or used.
 */
export async function acceptInvitation(
  db: Database,
  token: string,
  acceptingUserId: string,
  secret: string,
  correlationId?: string | undefined,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  const invitation = await findInvitationByToken(db, token, secret);
  if (!invitation) {
    throw new NotFoundError('Invitation not found, expired or already used');
  }

  const result = await withTenantTransaction(db, invitation.workspaceId, async (tx) => {
    // Claim the invitation FIRST, guarded by `accepted_at IS NULL`. If a
    // concurrent request already claimed it, zero rows update and we stop —
    // this is what makes single-use hold under a double-click or a race.
    const claimed = await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedUserId: acceptingUserId })
      .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt)))
      .returning({ id: invitations.id });

    if (claimed.length === 0) {
      throw new NotFoundError('Invitation already accepted');
    }

    // An existing membership wins over the invitation's role if it is
    // stronger — accepting an invite must never DOWNGRADE someone.
    const [existing] = await tx
      .select({ id: memberships.id, role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, acceptingUserId),
          eq(memberships.workspaceId, invitation.workspaceId),
        ),
      )
      .limit(1);

    if (existing) {
      const role = strongerWorkspaceRole(existing.role, invitation.role);
      await tx
        .update(memberships)
        .set({ role, updatedAt: new Date() })
        .where(eq(memberships.id, existing.id));
      return { workspaceId: invitation.workspaceId, role };
    }

    await tx.insert(memberships).values({
      userId: acceptingUserId,
      workspaceId: invitation.workspaceId,
      role: invitation.role,
      invitedByUserId: null,
    });

    return { workspaceId: invitation.workspaceId, role: invitation.role };
  });

  await writeAuditEvent(db, {
    workspaceId: invitation.workspaceId,
    actorUserId: acceptingUserId,
    eventName: AUDIT_EVENTS.CRM_INVITATION_ACCEPTED,
    targetType: 'invitation',
    targetId: invitation.id,
    correlationId,
    metadata: { role: result.role },
  });

  return result;
}

/**
 * Notifier for invitation delivery.
 *
 * An interface because no transactional email provider exists yet (ADR-0018).
 * Defining the seam now means adding a provider later touches one file.
 */
export interface InvitationNotifier {
  send(invitation: { email: string; acceptUrl: string; workspaceName: string }): Promise<void>;
}

/**
 * Development notifier — prints the acceptance URL to the server console.
 *
 * ⚠️ Production MUST NOT use this. A silent no-op notifier in production means
 * invitations that are created, never delivered, and never noticed. The
 * composition root refuses to construct it when NODE_ENV is production.
 */
export class ConsoleInvitationNotifier implements InvitationNotifier {
  async send(invitation: {
    email: string;
    acceptUrl: string;
    workspaceName: string;
  }): Promise<void> {
    console.info('[invitation] delivery is not configured — acceptance link follows', {
      to: invitation.email,
      workspace: invitation.workspaceName,
      acceptUrl: invitation.acceptUrl,
    });
  }
}
