/**
 * In-process domain event publisher.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Delivers CRM domain events to subscribers within the same process. It is the
 * Stage 2 implementation of the `DomainEventPublisher` interface that
 * automation workers (Stage 12) will later satisfy with a transactional
 * outbox.
 *
 * WHY IN-PROCESS FIRST
 * At one instance there is nothing to distribute. The expensive part to change
 * later is the event NAMES and SHAPES, because subscribers depend on them;
 * the transport is comparatively cheap. Committing to the contract now and the
 * transport later is the right order.
 *
 * SUBSCRIBER FAILURES ARE ISOLATED
 * `publish` never throws. A subscriber that fails must not roll back the
 * business operation that already succeeded — a contact was created whether or
 * not a listener liked it.
 *
 * ⚠️ KNOWN LIMITATION: delivery is best-effort and in-memory. An event emitted
 * during a transaction that later rolls back has still been delivered. Fixing
 * that requires the outbox — recorded in docs/architecture/event-architecture.md.
 *
 * @see docs/architecture/event-architecture.md
 */

import type {
  CrmDomainEvent,
  CrmDomainEventName,
  DomainEventPublisher,
} from '@growth-os/contracts';

export type DomainEventHandler = (event: CrmDomainEvent) => void | Promise<void>;

export class InProcessEventPublisher implements DomainEventPublisher {
  readonly #handlers = new Map<CrmDomainEventName, Set<DomainEventHandler>>();

  subscribe(name: CrmDomainEventName, handler: DomainEventHandler): () => void {
    const existing = this.#handlers.get(name) ?? new Set<DomainEventHandler>();
    existing.add(handler);
    this.#handlers.set(name, existing);
    return () => existing.delete(handler);
  }

  publish(event: CrmDomainEvent): void {
    const handlers = this.#handlers.get(event.name);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        // Deliberately not awaited: publishing is fire-and-forget so a slow
        // subscriber cannot add latency to a user's request.
        void Promise.resolve(handler(event)).catch((error: unknown) => {
          console.error('[events] subscriber failed', {
            event: event.name,
            workspaceId: event.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        console.error('[events] subscriber threw synchronously', {
          event: event.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** Publisher that records events. Test-only. */
export class RecordingEventPublisher implements DomainEventPublisher {
  readonly events: CrmDomainEvent[] = [];

  publish(event: CrmDomainEvent): void {
    this.events.push(event);
  }

  namesFor(workspaceId: string): string[] {
    return this.events.filter((event) => event.workspaceId === workspaceId).map((e) => e.name);
  }

  clear(): void {
    this.events.length = 0;
  }
}
