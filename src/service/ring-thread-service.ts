/**
 * TASK RING-CONTRACT-01 (Dev A stub): thread persistence service.
 *
 * FROZEN CONTRACT (Dev A implements against this; behavior spec only):
 * - `RingThread { threadId, title, role, createdAt, runs: runId[] }`.
 * - Endpoints: POST /api/v1/ring/threads, GET /api/v1/ring/threads/:id,
 *   POST /api/v1/ring/threads/:id/messages (starts a run carrying prior
 *   conversation context). Existing /ring/runs stays working unchanged.
 * - Threads persist under `.maos/ring-runs/threads/` as JSON; reopening
 *   rebuilds from stored history (no in-memory loss on restart). Dev A ships
 *   a restart-reload test.
 * - Roles: 'operator' | 'maintenance' | 'safety' | 'manager' (default
 *   `operator` so current tests don't break); role affects system prompt +
 *   tool set (system-prompt + registry-visibility changes are Dev C's, keyed
 *   off `thread.role` stored here).
 *
 * This stub exposes the interface with NOT_IMPLEMENTED bodies so Dev B/C
 * compile against it without waiting for Dev A.
 */

import type { RingRole, RingThread } from './ring-contract';

export interface RingThreadStore {
  createThread(title: string, role: RingRole): RingThread;
  getThread(threadId: string): RingThread | undefined;
  appendRun(threadId: string, runId: string): RingThread;
  listThreadIds(): string[];
}

const NOT_IMPLEMENTED = 'RING_THREAD_NOT_IMPLEMENTED: Dev A lane implements thread persistence.';

export class RingThreadService implements RingThreadStore {
  constructor(private readonly _projectRoot: string) {}

  createThread(_title: string, _role: RingRole): RingThread {
    throw new Error(NOT_IMPLEMENTED);
  }

  getThread(_threadId: string): RingThread | undefined {
    throw new Error(NOT_IMPLEMENTED);
  }

  appendRun(_threadId: string, _runId: string): RingThread {
    throw new Error(NOT_IMPLEMENTED);
  }

  listThreadIds(): string[] {
    throw new Error(NOT_IMPLEMENTED);
  }
}
