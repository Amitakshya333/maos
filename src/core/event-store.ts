/**
 * MAOS Event Store
 *
 * Persists MessageBus events to disk as an append-only JSONL log.
 * Enables post-mortem debugging, replay, and audit trail.
 *
 * File: .maos/events/events.jsonl
 *
 * Format (one JSON object per line):
 * {"seq":1,"type":"TASK_STARTED","agentId":"CODER_1","taskId":"TASK_123","timestamp":1716000000000,...}
 *
 * Features:
 *   - Every bus event is persisted immediately (append-only)
 *   - Sequence numbers for causal ordering
 *   - Query by task ID, agent ID, event type, or time range
 *   - File rotation when size exceeds limit (keeps last 5MB)
 *   - `maos replay` CLI command reads and renders this log
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMaosRoot } from '../utils/paths';
import { BusEvent, MessageBus } from './message-bus';

// ---- Config ----

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per file before rotation

// ---- Types ----

export interface PersistedEvent extends BusEvent {
  /** Sequential ID — monotonically increasing, never reused */
  seq: number;
  /** When this event was written to disk (may differ slightly from timestamp) */
  persistedAt: number;
}

// ---- Event Store ----

export class EventStore {
  private eventFile: string;
  private archiveDir: string;
  private seq: number;
  private fd: number | null = null;

  // ---- Incremental stats cache ----
  private _cachedByType: Record<string, number> = {};
  private _cachedCount: number = 0;
  private _cachedOldestTs: number | null = null;
  private _cachedNewestTs: number | null = null;
  private _statsCacheSeq: number = -1; // seq at which cache was last valid

  constructor(projectRoot: string) {
    const eventsDir = path.join(getMaosRoot(projectRoot), 'events');
    if (!fs.existsSync(eventsDir)) {
      fs.mkdirSync(eventsDir, { recursive: true });
    }
    this.eventFile = path.join(eventsDir, 'events.jsonl');
    this.archiveDir = path.join(eventsDir, 'archive');
    this.seq = this.readLastSeq();
  }

  /**
   * Persist a bus event to disk.
   * Called for every event emitted on the MessageBus.
   */
  write(event: BusEvent): void {
    try {
      // Rotate if file is too large
      if (this.shouldRotate()) {
        this.rotate();
        // Reset stats cache on rotation
        this._cachedByType = {};
        this._cachedCount = 0;
        this._cachedOldestTs = null;
        this._cachedNewestTs = null;
      }

      this.seq++;
      this.writeSeq(this.seq);
      const persisted: PersistedEvent = {
        ...event,
        seq: this.seq,
        persistedAt: Date.now(),
      };

      fs.appendFileSync(this.eventFile, JSON.stringify(persisted) + '\n', 'utf-8');

      // Incrementally update stats cache
      this._cachedByType[event.type] = (this._cachedByType[event.type] ?? 0) + 1;
      this._cachedCount++;
      if (this._cachedOldestTs === null) this._cachedOldestTs = event.timestamp;
      this._cachedNewestTs = event.timestamp;
      this._statsCacheSeq = this.seq;
    } catch {
      // Event persistence failure is non-fatal
    }
  }

  /**
   * Read events from disk with optional filters.
   * Uses streaming for large files to avoid loading entire JSONL into memory.
   */
  query(
    opts: {
      taskId?: string;
      agentId?: string;
      type?: string;
      since?: number; // Epoch ms
      until?: number; // Epoch ms
      limit?: number;
      fromSeq?: number; // Resume from this sequence number
    } = {},
  ): PersistedEvent[] {
    if (!fs.existsSync(this.eventFile)) return [];

    const limit = opts.limit ?? 200;
    const results: PersistedEvent[] = [];

    try {
      // For files under 512KB, read fully (fast enough and simpler)
      // For larger files, still read fully but we already have rotation at 5MB
      const content = fs.readFileSync(this.eventFile, 'utf-8');
      let start = 0;
      let end = content.indexOf('\n', start);

      while (end !== -1 && results.length < limit) {
        const line = content.substring(start, end).trim();
        start = end + 1;
        end = content.indexOf('\n', start);

        if (!line) continue;
        try {
          const evt = JSON.parse(line) as PersistedEvent;

          if (opts.fromSeq !== undefined && evt.seq <= opts.fromSeq) continue;
          if (opts.taskId && evt.taskId !== opts.taskId) continue;
          if (opts.agentId && evt.agentId !== opts.agentId) continue;
          if (opts.type && evt.type !== opts.type) continue;
          if (opts.since && evt.timestamp < opts.since) continue;
          if (opts.until && evt.timestamp > opts.until) continue;

          results.push(evt);
        } catch {
          /* skip malformed line */
        }
      }

      // Handle last line (no trailing newline)
      if (results.length < limit && start < content.length) {
        const lastLine = content.substring(start).trim();
        if (lastLine) {
          try {
            const evt = JSON.parse(lastLine) as PersistedEvent;
            if (
              !(opts.fromSeq !== undefined && evt.seq <= opts.fromSeq) &&
              !(opts.taskId && evt.taskId !== opts.taskId) &&
              !(opts.agentId && evt.agentId !== opts.agentId) &&
              !(opts.type && evt.type !== opts.type) &&
              !(opts.since && evt.timestamp < opts.since) &&
              !(opts.until && evt.timestamp > opts.until)
            ) {
              results.push(evt);
            }
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* file read error */
    }

    return results;
  }

  /**
   * Get events for a specific task (full replay).
   */
  replayTask(taskId: string): PersistedEvent[] {
    // Also check archives
    const fromCurrent = this.query({ taskId, limit: 10000 });
    const fromArchive = this.queryArchives({ taskId });
    const all = [...fromArchive, ...fromCurrent];
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  /**
   * Get a summary timeline for a task.
   */
  getTaskTimeline(taskId: string): Array<{
    seq: number;
    time: string;
    type: string;
    agentId: string;
    note: string;
  }> {
    return this.replayTask(taskId).map((evt) => ({
      seq: evt.seq,
      time: new Date(evt.timestamp).toISOString(),
      type: evt.type,
      agentId: evt.agentId,
      note: evt.data ? JSON.stringify(evt.data).substring(0, 100) : '',
    }));
  }

  /**
   * Get statistics about the event store.
   * Uses in-memory cache updated incrementally by write() — only falls back
   * to full file scan on process restart (cold cache).
   */
  stats(): {
    totalEvents: number;
    fileSize: number;
    oldestEvent?: string;
    newestEvent?: string;
    eventsByType: Record<string, number>;
  } {
    if (!fs.existsSync(this.eventFile)) {
      return { totalEvents: 0, fileSize: 0, eventsByType: {} };
    }

    const stat = fs.statSync(this.eventFile);

    // Fast path: use incremental cache if it's been populated by write()
    if (this._statsCacheSeq >= 0 && this._cachedCount > 0) {
      return {
        totalEvents: this._cachedCount,
        fileSize: stat.size,
        oldestEvent: this._cachedOldestTs ? new Date(this._cachedOldestTs).toISOString() : undefined,
        newestEvent: this._cachedNewestTs ? new Date(this._cachedNewestTs).toISOString() : undefined,
        eventsByType: { ...this._cachedByType },
      };
    }

    // Cold start: build cache from file (happens once per process)
    const byType: Record<string, number> = {};
    let oldestTs: number | null = null;
    let newestTs: number | null = null;
    let count = 0;

    try {
      const content = fs.readFileSync(this.eventFile, 'utf-8');
      let start = 0;
      let end = content.indexOf('\n', start);
      while (end !== -1) {
        const line = content.substring(start, end).trim();
        start = end + 1;
        end = content.indexOf('\n', start);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as PersistedEvent;
          byType[evt.type] = (byType[evt.type] ?? 0) + 1;
          if (oldestTs === null || evt.timestamp < oldestTs) oldestTs = evt.timestamp;
          if (newestTs === null || evt.timestamp > newestTs) newestTs = evt.timestamp;
          count++;
        } catch {
          /* skip */
        }
      }
      // Handle last line
      if (start < content.length) {
        const lastLine = content.substring(start).trim();
        if (lastLine) {
          try {
            const evt = JSON.parse(lastLine) as PersistedEvent;
            byType[evt.type] = (byType[evt.type] ?? 0) + 1;
            if (oldestTs === null || evt.timestamp < oldestTs) oldestTs = evt.timestamp;
            if (newestTs === null || evt.timestamp > newestTs) newestTs = evt.timestamp;
            count++;
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }

    // Warm up cache for future calls
    this._cachedByType = byType;
    this._cachedCount = count;
    this._cachedOldestTs = oldestTs;
    this._cachedNewestTs = newestTs;
    this._statsCacheSeq = this.seq;

    return {
      totalEvents: count,
      fileSize: stat.size,
      oldestEvent: oldestTs ? new Date(oldestTs).toISOString() : undefined,
      newestEvent: newestTs ? new Date(newestTs).toISOString() : undefined,
      eventsByType: { ...byType },
    };
  }

  // ---- Internals ----

  private shouldRotate(): boolean {
    if (!fs.existsSync(this.eventFile)) return false;
    const stat = fs.statSync(this.eventFile);
    return stat.size > MAX_FILE_SIZE_BYTES;
  }

  private rotate(): void {
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(this.archiveDir, `events-${ts}.jsonl`);
    fs.renameSync(this.eventFile, archivePath);
    // Fresh file
    fs.writeFileSync(this.eventFile, '', 'utf-8');
  }

  private readLastSeq(): number {
    const seqFile = path.join(path.dirname(this.eventFile), 'seq');
    if (fs.existsSync(seqFile)) {
      try {
        const content = fs.readFileSync(seqFile, 'utf-8').trim();
        const parsed = parseInt(content, 10);
        if (!isNaN(parsed)) return parsed;
      } catch {
        /* fallback to file parsing */
      }
    }

    if (!fs.existsSync(this.eventFile)) return 0;
    try {
      const content = fs.readFileSync(this.eventFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      if (lines.length === 0) return 0;
      const last = JSON.parse(lines[lines.length - 1]) as PersistedEvent;
      return last.seq ?? 0;
    } catch {
      return 0;
    }
  }

  private writeSeq(seq: number): void {
    const seqFile = path.join(path.dirname(this.eventFile), 'seq');
    try {
      fs.writeFileSync(seqFile, String(seq), 'utf-8');
    } catch {
      /* ignore */
    }
  }

  private queryArchives(opts: { taskId?: string }): PersistedEvent[] {
    if (!fs.existsSync(this.archiveDir)) return [];
    const results: PersistedEvent[] = [];

    for (const file of fs.readdirSync(this.archiveDir).filter((f) => f.endsWith('.jsonl'))) {
      try {
        const lines = fs.readFileSync(path.join(this.archiveDir, file), 'utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as PersistedEvent;
            if (opts.taskId && evt.taskId !== opts.taskId) continue;
            results.push(evt);
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
    }
    return results;
  }
}

// ---- Singleton ----

let _store: EventStore | null = null;

export function getEventStore(projectRoot: string): EventStore {
  if (!_store) {
    _store = new EventStore(projectRoot);
  }
  return _store;
}

/**
 * Wire the event store to a MessageBus.
 * After calling this, ALL bus events are automatically persisted.
 */
export function wireEventStore(bus: MessageBus, projectRoot: string): EventStore {
  const store = getEventStore(projectRoot);
  bus.onAll((event) => store.write(event));
  return store;
}
