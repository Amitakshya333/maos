/**
 * MAOS Event Service
 *
 * Wraps event store queries and replay.
 * Extracted from: cli/index.ts (replay command), core/event-store.ts.
 */

import { EventStore, PersistedEvent } from '../core/event-store';
import type { AuditEvent, EventStats, EventFilter, AuditEventType, SequencedEvent } from '../domain/schemas';

/**
 * Convert a core PersistedEvent to a domain AuditEvent.
 */
function toAuditEvent(pe: PersistedEvent): AuditEvent {
  return {
    schemaVersion: 1,
    seq: pe.seq,
    type: pe.type as AuditEventType,
    agentId: pe.agentId,
    taskId: pe.taskId,
    timestamp: pe.timestamp,
    data: pe.data as Record<string, unknown> | undefined,
  };
}

export class EventService {
  private store: EventStore;

  constructor(projectRoot: string) {
    this.store = new EventStore(projectRoot);
  }

  /**
   * Get the full replay of events for a specific task as AuditEvents.
   */
  getTaskTimeline(taskId: string): AuditEvent[] {
    const events = this.store.replayTask(taskId);
    return events.map(toAuditEvent);
  }

  /**
   * Get the summary timeline for a task (as used by the replay CLI command).
   */
  getTaskTimelineSummary(taskId: string): Array<{
    seq: number;
    time: string;
    type: string;
    agentId: string;
    note: string;
  }> {
    return this.store.getTaskTimeline(taskId);
  }

  /**
   * Query events with optional filters.
   */
  query(filter?: EventFilter): AuditEvent[] {
    const events = this.store.query({
      agentId: filter?.agentId,
      type: filter?.type,
      limit: filter?.limit ?? 50,
    });
    return events.map(toAuditEvent);
  }

  /**
   * Get event store statistics.
   */
  getStats(): EventStats {
    const s = this.store.stats();
    return {
      totalEvents: s.totalEvents,
      fileSize: s.fileSize,
      oldestEvent: s.oldestEvent ?? null,
      newestEvent: s.newestEvent ?? null,
      eventsByType: s.eventsByType,
    };
  }

  private readonly listeners: Set<(event: SequencedEvent) => void> = new Set();

  /**
   * Register a listener for newly persisted sequenced events.
   */
  onEvent(listener: (event: SequencedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Persist a SequencedEvent to disk with monotonic sequence allocation.
   * Flushes to disk first, then notifies any registered listeners.
   */
  recordEvent(event: {
    eventId?: string;
    eventType: string;
    projectId: string;
    runId?: string;
    taskId?: string;
    sequence?: number;
    occurredAt?: string;
    correlationId: string;
    payload: unknown;
  }): SequencedEvent {
    const persisted = this.store.writeSequenced(event);
    for (const listener of this.listeners) {
      try {
        listener(persisted);
      } catch {
        // Listener execution failure must never roll back disk persistence
      }
    }
    return persisted;
  }

  /**
   * Query sequenced events starting strictly after fromSeq.
   */
  querySequenced(opts: {
    fromSeq?: number;
    limit?: number;
    projectId?: string;
    runId?: string;
  } = {}): SequencedEvent[] {
    return this.store.querySequenced(opts);
  }

  /**
   * Get the oldest and latest sequence numbers currently retained in storage.
   */
  getSequenceBounds(): { oldest: number; latest: number } {
    return this.store.getSequenceBounds();
  }
}
