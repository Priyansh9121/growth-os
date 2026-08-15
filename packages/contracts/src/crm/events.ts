/**
 * CRM domain events.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * The typed vocabulary that future automation workers (Stage 12) and the
 * attribution pipeline (Stage 15) will subscribe to. Defined now so that the
 * services emit a stable shape from their first commit, rather than having
 * event names invented later against already-written call sites.
 *
 * DELIBERATELY NOT A MESSAGE BROKER
 * Stage 2 publishes to an in-process bus. The transport is the cheap part to
 * change; the event NAMES and PAYLOAD SHAPES are the expensive part, because
 * subscribers depend on them. See docs/architecture/event-architecture.md.
 *
 * PAYLOADS CARRY IDENTIFIERS, NOT PII
 * An event says `contactId`, never the contact's name, email or phone. Events
 * are the least-controlled surface in the system — they fan out to
 * subscribers, queues and logs — so putting personal data in one distributes
 * it everywhere by default. A subscriber that needs the person loads them
 * through a tenant-scoped service, which re-checks authorization.
 */

import type { ActorType, OpportunityStatus, SourceType, TaskPriority } from './enums';

/** Every domain event carries its tenant, so a subscriber can never act unscoped. */
interface DomainEventBase {
  readonly workspaceId: string;
  /** ISO-8601, from the server clock. */
  readonly occurredAt: string;
  /** Ties the event back to the request and to the audit trail. */
  readonly correlationId: string | null;
  readonly actorType: ActorType;
  readonly actorUserId: string | null;
}

export interface ContactCreatedEvent extends DomainEventBase {
  readonly name: 'crm.contact.created';
  readonly contactId: string;
  readonly hasEmail: boolean;
  readonly hasPhone: boolean;
}

export interface AcquisitionRecordedEvent extends DomainEventBase {
  readonly name: 'crm.acquisition.recorded';
  readonly acquisitionId: string;
  readonly contactId: string;
  readonly sourceType: SourceType;
  /** True when this is the contact's first acquisition — i.e. first touch. */
  readonly isFirstTouch: boolean;
}

export interface OpportunityCreatedEvent extends DomainEventBase {
  readonly name: 'crm.opportunity.created';
  readonly opportunityId: string;
  readonly contactId: string;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly estimatedValueMinor: number;
  readonly currency: string;
}

export interface OpportunityStageChangedEvent extends DomainEventBase {
  readonly name: 'crm.opportunity.stage_changed';
  readonly opportunityId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly status: OpportunityStatus;
}

export interface TaskCreatedEvent extends DomainEventBase {
  readonly name: 'crm.task.created';
  readonly taskId: string;
  readonly assignedUserId: string | null;
  readonly priority: TaskPriority;
  readonly dueAt: string | null;
}

export interface TaskCompletedEvent extends DomainEventBase {
  readonly name: 'crm.task.completed';
  readonly taskId: string;
}

export type CrmDomainEvent =
  | ContactCreatedEvent
  | AcquisitionRecordedEvent
  | OpportunityCreatedEvent
  | OpportunityStageChangedEvent
  | TaskCreatedEvent
  | TaskCompletedEvent;

export type CrmDomainEventName = CrmDomainEvent['name'];

/**
 * Publishes domain events.
 *
 * An interface rather than a concrete class so the in-process implementation
 * can be replaced by an outbox-backed one (Stage 12) without touching a single
 * service.
 *
 * Publishing MUST NOT throw. A subscriber failing is not a reason to fail the
 * business operation that succeeded — the current in-process implementation
 * therefore isolates and logs subscriber errors.
 */
export interface DomainEventPublisher {
  publish(event: CrmDomainEvent): void;
}
